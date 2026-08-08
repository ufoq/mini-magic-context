/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    closeDatabase,
    isDatabasePersisted,
    openDatabase,
    resolveDatabasePath,
} from "./storage-db";
import { clearSession } from "./storage-meta-session";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): string {
    const dataHome = makeTempDir(prefix);
    process.env.XDG_DATA_HOME = dataHome;
    return dataHome;
}

function resolveDbPath(dataHome: string): string {
    return join(dataHome, "cortexkit", "mini-magic-context", "context.db");
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;
});

describe("storage-db", () => {
    describe("#given openDatabase", () => {
        it("#when called first time #then creates DB with WAL mode and busy_timeout", () => {
            const dataHome = useTempDataHome("storage-db-wal-");

            const db = openDatabase();

            const wal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
            const timeout = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
            expect(wal.journal_mode.toLowerCase()).toBe("wal");
            expect(Object.values(timeout)[0]).toBe(5000);
            expect(existsSync(resolveDbPath(dataHome))).toBe(true);
            expect(isDatabasePersisted(db)).toBe(true);
        });

        it("#when called first time #then restricts storage dir to 0o700 and DB files to 0o600", () => {
            // POSIX-only: chmod is a no-op on Windows (modes are not honored).
            if (process.platform === "win32") return;
            const dataHome = useTempDataHome("storage-db-perms-");

            openDatabase();

            const dbPath = resolveDbPath(dataHome);
            const dbDir = dirname(dbPath);
            // Low 9 permission bits only (mask off file-type/setuid bits).
            expect(statSync(dbDir).mode & 0o777).toBe(0o700);
            expect(statSync(dbPath).mode & 0o777).toBe(0o600);
            for (const suffix of ["-wal", "-shm"]) {
                const sidecar = `${dbPath}${suffix}`;
                if (existsSync(sidecar)) {
                    expect(statSync(sidecar).mode & 0o777).toBe(0o600);
                }
            }
        });

        it("#when called first time #then creates the retained mini schema", () => {
            useTempDataHome("storage-db-tables-");

            const db = openDatabase();

            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as Array<{ name: string }>;
            const tableNames = tables.map((t) => t.name).sort();
            expect(tableNames).toEqual([
                "compartment_chunk_embeddings",
                "compartment_state_lease",
                "compartments",
                "compression_depth",
                "embedding_identity_active",
                "embedding_registrations",
                "git_sweep_coordinator",
                "m0_mutation_log",
                "message_history_fts",
                "message_history_fts_config",
                "message_history_fts_content",
                "message_history_fts_data",
                "message_history_fts_docsize",
                "message_history_fts_idx",
                "message_history_index",
                "message_history_orphan_sweep",
                "message_history_source",
                "mini_schema",
                "pending_ops",
                "pending_session_cleanup",
                "recomp_compartments",
                "session_meta",
                "session_projects",
                "source_contents",
                "sqlite_sequence",
                "tags",
            ]);
        });

        it("#when clearSession runs #then every session-scoped table is emptied", () => {
            // Discover the contract from schema shape instead of maintaining a
            // second table list. Any new table with session_id is seeded here and
            // must be cleared by clearSession, so lifecycle omissions fail loudly.
            useTempDataHome("storage-db-clearsession-");
            const db = openDatabase();
            const sessionId = "ses_clearsession_fresh";
            const tableNames = (
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                    )
                    .all() as Array<{ name: string }>
            )
                .map((row) => row.name)
                .filter((table) => {
                    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                        name: string;
                    }>;
                    return columns.some((column) => column.name === "session_id");
                });

            db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
            for (const table of tableNames) {
                const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                    name: string;
                    type: string;
                    notnull: number;
                    dflt_value: string | null;
                    pk: number;
                }>;
                const insertedColumns = columns.filter(
                    (column) =>
                        column.name === "session_id" ||
                        (column.dflt_value === null &&
                            (column.notnull === 1 ||
                                (column.pk > 0 && column.type.toUpperCase() !== "INTEGER"))),
                );
                const values = insertedColumns.map((column) => {
                    if (column.name === "session_id") return sessionId;
                    const type = column.type.toUpperCase();
                    if (type.includes("INT") || type.includes("REAL")) return 1;
                    if (type.includes("BLOB")) return new Uint8Array([1]);
                    return "seed";
                });
                const placeholders = insertedColumns.map(() => "?").join(", ");
                db.prepare(
                    `INSERT INTO ${table} (${insertedColumns.map((column) => column.name).join(", ")}) VALUES (${placeholders})`,
                ).run(...values);
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                        .get(sessionId),
                ).toEqual({ count: 1 });
            }
            db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");

            clearSession(db, sessionId);

            for (const table of tableNames) {
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                        .get(sessionId),
                    `${table} retained session-scoped rows`,
                ).toEqual({ count: 0 });
            }
        });

        it("#when called first time #then creates required session-scoped indexes", () => {
            useTempDataHome("storage-db-indexes-");

            const db = openDatabase();
            const indexes = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
                .all() as Array<{ name: string }>;
            const indexNames = indexes.map((item) => item.name);

            for (const indexName of [
                "idx_tags_session_tag_number",
                "idx_tags_tool_composite",
                "idx_pending_ops_session",
                "idx_source_contents_session",
                "idx_compartments_session_range",
                "idx_cce_session",
                "idx_m0_mutation_log_session",
            ]) {
                expect(indexNames).toContain(indexName);
            }
        });

        it("#when called a second time #then returns cached instance (singleton)", () => {
            useTempDataHome("storage-db-cached-");

            const db1 = openDatabase();
            const db2 = openDatabase();

            expect(db1).toBe(db2);
        });

        it("#when file path setup fails #then throws so callers fail closed (no in-memory fallback)", () => {
            const dataHome = useTempDataHome("storage-db-fallback-");
            // Block mkdirSync by planting a file at the cortexkit segment of
            // the new shared path. See storage.test.ts for the same pattern.
            writeFileSync(join(dataHome, "cortexkit"), "not-a-directory", "utf-8");

            // Failing closed is intentional. Falling back to :memory: silently
            // disables persistent state (memories, historian compartments,
            // tags) but keeps the transform running, which on Pi/OpenCode can
            // let the full raw history reach the model and overflow context.
            // Callers must catch this and disable Magic Context for the run.
            expect(() => openDatabase()).toThrow(/storage unavailable/i);
        });

        it("#when called first time #then creates retained session_meta columns", () => {
            useTempDataHome("storage-db-session-meta-mini-");
            const db = openDatabase();
            const columns = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            const columnNames = columns.map((column) => column.name);

            for (const columnName of [
                "session_id",
                "counter",
                "historian_failure_count",
                "historian_last_error",
                "historian_last_failure_at",
                "harness",
            ]) {
                expect(columnNames).toContain(columnName);
            }
        });

        it("#when called first time #then omits removed memory embedding tables", () => {
            useTempDataHome("storage-db-no-memory-embeddings-");
            const db = openDatabase();
            const row = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'",
                )
                .get();

            expect(row).toBeNull();
        });
    });

    describe("#given closeDatabase", () => {
        it("#when called after openDatabase #then clears the cached instance", () => {
            useTempDataHome("storage-db-close-");

            const db1 = openDatabase();
            closeDatabase();
            const db2 = openDatabase();

            expect(db1).not.toBe(db2);
        });

        it("#when called multiple times #then does not throw", () => {
            useTempDataHome("storage-db-multi-close-");

            openDatabase();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
        });

        it("#when called without prior open #then does not throw", () => {
            expect(() => closeDatabase()).not.toThrow();
        });
    });

    // Regression guard for the 2026-06-01 (v26) / 2026-06-19 (v41) incidents:
    // a `bun test` run from a CWD whose bunfig lacks `[test] preload` ran the
    // package suites with NO isolation, so a bare openDatabase() migrated the
    // user's REAL shared DB. The NODE_ENV=test backstop in resolveDatabasePath
    // makes that structurally impossible from ANY CWD.
    describe("#given the test-isolation backstop", () => {
        const realStorageRoot = join(homedir(), ".local", "share", "cortexkit");

        it("#when NODE_ENV=test and XDG_DATA_HOME unset #then never resolves to the real shared DB", () => {
            // Simulate an UNISOLATED run: no preload-set vars at all.
            const savedXdg = process.env.XDG_DATA_HOME;
            const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            process.env.NODE_ENV = "test";
            delete process.env.XDG_DATA_HOME;
            delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            try {
                const { dbPath } = resolveDatabasePath();
                expect(dbPath.startsWith(realStorageRoot)).toBe(false);
                expect(dbPath.includes("mc-test-db-backstop-")).toBe(true);
            } finally {
                if (savedXdg !== undefined) process.env.XDG_DATA_HOME = savedXdg;
                if (savedTestDir !== undefined)
                    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
            }
        });

        it("#when a test sets its own XDG_DATA_HOME #then that controlled dir is honored", () => {
            const dataHome = useTempDataHome("storage-db-backstop-xdg-");
            const { dbPath } = resolveDatabasePath();
            expect(dbPath).toBe(resolveDbPath(dataHome));
        });

        it("#then every test package wires the isolation preload (root + plugin + pi-plugin + cli)", () => {
            // Structural guard: a new test package that forgets its bunfig
            // `[test] preload` is the exact hole that caused both incidents.
            const repoRoot = join(__dirname, "..", "..", "..", "..", "..");
            const bunfigs = [
                "bunfig.toml",
                "packages/plugin/bunfig.toml",
                "packages/pi-plugin/bunfig.toml",
                "packages/cli/bunfig.toml",
            ];
            for (const rel of bunfigs) {
                const full = join(repoRoot, rel);
                expect(existsSync(full)).toBe(true);
                const body = readFileSync(full, "utf8");
                expect(body.includes("[test]")).toBe(true);
                expect(body.includes("preload")).toBe(true);
                expect(body.includes("test-preload.ts")).toBe(true);
            }
        });
    });
});
