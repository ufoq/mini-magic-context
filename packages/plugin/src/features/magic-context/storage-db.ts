import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getMagicContextStorageDir } from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    classifyMiniDatabase,
    initializeMiniDatabase,
    MINI_SCHEMA_VERSION,
} from "./storage-mini-schema";

const databases = new Map<string, Database>();
const pendingAsyncOpens = new Map<string, Promise<Database | null>>();
const persistenceByDatabase = new WeakMap<Database, boolean>();
const persistenceErrorByDatabase = new WeakMap<Database, string>();
const pathByDatabase = new WeakMap<Database, string>();

let lastSchemaFenceRejection: { persistedVersion: number; supportedVersion: number } | null = null;

export function getSchemaFenceRejection(): {
    persistedVersion: number;
    supportedVersion: number;
} | null {
    return lastSchemaFenceRejection;
}

export const LATEST_SUPPORTED_VERSION = MINI_SCHEMA_VERSION;
const PERMISSIONS_ENFORCEABLE = process.platform !== "win32";

function ensureSecureStorageDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!PERMISSIONS_ENFORCEABLE) return;
    try {
        chmodSync(dir, 0o700);
    } catch (error) {
        log(
            `[magic-context] could not restrict storage dir permissions on ${dir}: ${getErrorMessage(error)}`,
        );
    }
}

function restrictDatabaseFilePermissions(dbPath: string): void {
    if (!PERMISSIONS_ENFORCEABLE) return;
    for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${dbPath}${suffix}`;
        if (!existsSync(file)) continue;
        try {
            chmodSync(file, 0o600);
        } catch (error) {
            log(
                `[magic-context] could not restrict DB file permissions on ${file}: ${getErrorMessage(error)}`,
            );
        }
    }
}

export interface OpenDatabaseOptions {
    dbPath?: string;
    latestSupportedVersion?: number;
}

let testBackstopDbDir: string | null = null;
let testBackstopWarned = false;

function getTestBackstopDbDir(): string {
    if (!testBackstopDbDir) {
        testBackstopDbDir = join(
            mkdtempSync(join(tmpdir(), "mc-test-db-backstop-")),
            "cortexkit",
            "mini-magic-context",
        );
    }
    return testBackstopDbDir;
}

export function resolveDatabasePath(dbPathOverride?: string): { dbDir: string; dbPath: string } {
    if (dbPathOverride) {
        return { dbDir: dirname(dbPathOverride), dbPath: dbPathOverride };
    }
    const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    if (testDataDir && !process.env.XDG_DATA_HOME) {
        const dbDir = join(testDataDir, "cortexkit", "mini-magic-context");
        return { dbDir, dbPath: join(dbDir, "context.db") };
    }
    if (process.env.NODE_ENV === "test" && !process.env.XDG_DATA_HOME) {
        const dbDir = getTestBackstopDbDir();
        if (!testBackstopWarned) {
            testBackstopWarned = true;
            log(
                `[magic-context] TEST BACKSTOP: redirecting database access to ${dbDir}; configure the package test preload for explicit isolation.`,
            );
        }
        return { dbDir, dbPath: join(dbDir, "context.db") };
    }
    const dbDir = getMagicContextStorageDir();
    return { dbDir, dbPath: join(dbDir, "context.db") };
}

export function getDatabasePath(db: Database): string | null {
    return pathByDatabase.get(db) ?? null;
}

export function getPersistedSchemaVersion(db: Database): number {
    const hasSchema = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mini_schema'")
        .get();
    if (!hasSchema) return 0;
    const row = db.prepare("SELECT version FROM mini_schema LIMIT 1").get() as
        | { version?: unknown }
        | undefined;
    return typeof row?.version === "number" ? row.version : 0;
}

export function schemaVersionIsSupported(
    db: Database,
    latestSupportedVersion = LATEST_SUPPORTED_VERSION,
): boolean {
    return (
        latestSupportedVersion === LATEST_SUPPORTED_VERSION &&
        classifyMiniDatabase(db) === "current"
    );
}

export function isCurrentMiniDatabase(db: Database): boolean {
    return classifyMiniDatabase(db) === "current";
}

function getRuntimeLatestSupportedVersion(options?: OpenDatabaseOptions): number {
    return options?.latestSupportedVersion ?? LATEST_SUPPORTED_VERSION;
}

export function enforceSchemaFence(
    db: Database,
    dbPath: string,
    latestSupportedVersion: number,
): boolean {
    const persistedVersion = getPersistedSchemaVersion(db);
    if (persistedVersion === 0 || persistedVersion === latestSupportedVersion) return true;
    lastSchemaFenceRejection = { persistedVersion, supportedVersion: latestSupportedVersion };
    log(
        `[magic-context] storage fatal: refusing to open ${dbPath}; database schema v${persistedVersion} does not match supported Mini schema v${latestSupportedVersion}. Start with a fresh database.`,
    );
    return false;
}

let sqlitePragmaConfig: { cacheSizeMb: number; mmapSizeMb: number } = {
    cacheSizeMb: 64,
    mmapSizeMb: 0,
};

export function setSqlitePragmaConfig(config: { cacheSizeMb: number; mmapSizeMb: number }): void {
    sqlitePragmaConfig = config;
}

export function applySqliteTuningPragmas(db: Database): void {
    db.exec(`PRAGMA cache_size=-${Math.round(sqlitePragmaConfig.cacheSizeMb * 1024)}`);
    db.exec(`PRAGMA mmap_size=${Math.round(sqlitePragmaConfig.mmapSizeMb * 1024 * 1024)}`);
    db.exec("PRAGMA analysis_limit=400");
}

export function runSqliteOptimize(db: Database): void {
    try {
        db.exec("PRAGMA analysis_limit=400");
        db.exec("PRAGMA optimize");
    } catch {
        // Best-effort planner maintenance.
    }
}

function configureDatabaseConnection(db: Database): void {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA journal_mode=WAL");
    applySqliteTuningPragmas(db);
}

export function initializeDatabase(db: Database): void {
    configureDatabaseConnection(db);
    db.exec("BEGIN IMMEDIATE");
    try {
        const state = classifyMiniDatabase(db);
        if (state === "fresh") initializeMiniDatabase(db);
        else if (state !== "current") {
            throw new Error("refusing to initialize a non-empty, non-current database");
        }
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function canOpenMiniDatabase(db: Database, dbPath: string): boolean {
    const state = classifyMiniDatabase(db);
    if (state === "fresh" || state === "current") return true;
    const persistedVersion = getPersistedSchemaVersion(db);
    lastSchemaFenceRejection = {
        persistedVersion,
        supportedVersion: LATEST_SUPPORTED_VERSION,
    };
    log(
        `[magic-context] storage fatal: refusing to open ${dbPath}; expected an empty database or Mini schema v${MINI_SCHEMA_VERSION}. Existing databases are never migrated or repaired.`,
    );
    return false;
}

function finishDatabaseOpen(db: Database, dbPath: string): Database {
    restrictDatabaseFilePermissions(dbPath);
    databases.set(dbPath, db);
    pathByDatabase.set(db, dbPath);
    persistenceByDatabase.set(db, true);
    persistenceErrorByDatabase.delete(db);
    return db;
}

function openNewHandle(options: OpenDatabaseOptions): Database | null {
    const { dbDir, dbPath } = resolveDatabasePath(options.dbPath);
    const latestSupportedVersion = getRuntimeLatestSupportedVersion(options);
    ensureSecureStorageDir(dbDir);
    const db = new Database(dbPath);
    try {
        const schemaState = classifyMiniDatabase(db);
        if (!canOpenMiniDatabase(db, dbPath)) {
            closeQuietly(db);
            return null;
        }
        if (!enforceSchemaFence(db, dbPath, latestSupportedVersion)) {
            closeQuietly(db);
            return null;
        }
        if (schemaState === "fresh") initializeDatabase(db);
        else configureDatabaseConnection(db);
        return finishDatabaseOpen(db, dbPath);
    } catch (error) {
        closeQuietly(db);
        throw error;
    }
}

export function openDatabase(): Database | null;
export function openDatabase(dbPath: string): Database | null;
export function openDatabase(options: OpenDatabaseOptions): Database | null;
export function openDatabase(dbPathOrOptions?: string | OpenDatabaseOptions): Database | null {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : (dbPathOrOptions ?? {});
    const { dbPath } = resolveDatabasePath(options.dbPath);
    const existing = databases.get(dbPath);
    if (existing) return existing;
    try {
        return openNewHandle(options);
    } catch (error) {
        const detail = getErrorMessage(error);
        log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
        throw new Error(
            `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
        );
    }
}

export async function openDatabaseAsync(
    dbPathOrOptions?: string | OpenDatabaseOptions,
): Promise<Database | null> {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : (dbPathOrOptions ?? {});
    const { dbPath } = resolveDatabasePath(options.dbPath);
    const existing = databases.get(dbPath);
    if (existing) return existing;
    const pending = pendingAsyncOpens.get(dbPath);
    if (pending) return pending;
    const opening = Promise.resolve().then(() => openDatabase(options));
    pendingAsyncOpens.set(dbPath, opening);
    try {
        return await opening;
    } finally {
        if (pendingAsyncOpens.get(dbPath) === opening) pendingAsyncOpens.delete(dbPath);
    }
}

export function isDatabasePersisted(db: Database | null): boolean {
    return db ? (persistenceByDatabase.get(db) ?? false) : false;
}

export function getDatabasePersistenceError(db: Database | null): string | null {
    return db ? (persistenceErrorByDatabase.get(db) ?? null) : null;
}

export function closeDatabase(): void {
    pendingAsyncOpens.clear();
    for (const [key, db] of databases) {
        try {
            closeQuietly(db);
        } catch (error) {
            log("[magic-context] storage error:", error);
        } finally {
            databases.delete(key);
        }
    }
}

export type ContextDatabase = Database;
