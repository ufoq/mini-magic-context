import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { getLegacyOpenCodeMagicContextStorageDir } from "../../shared/data-path";
import { getHarness } from "../../shared/harness";
import { log } from "../../shared/logger";
import { Database, type Database as SqliteDatabase } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { resolveProjectIdentity } from "./memory/project-identity";
import { clearIndexedMessages, indexMessagesAfterOrdinal } from "./message-index";

type Row = Record<string, unknown>;

export interface ImportLegacySessionOptions {
    targetDb: SqliteDatabase;
    sessionId: string;
    sourceDbPath?: string;
    projectPath?: string;
    readRawMessages: (sessionId: string) => RawMessage[];
}

export interface ImportLegacySessionResult {
    sourceDbPath: string;
    compartments: number;
    chunkEmbeddings: number;
    sessionProjects: number;
    indexedMessages: number;
    status: "imported" | "already_imported";
}

function dataHome(): string {
    return process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim().length > 0
        ? process.env.XDG_DATA_HOME
        : join(homedir(), ".local", "share");
}

function candidateSourcePaths(explicit?: string): string[] {
    const paths = [
        explicit,
        process.env.MC_IMPORT_SOURCE_DB,
        join(dataHome(), "cortexkit", "magic-context", "context.db"),
        join(getLegacyOpenCodeMagicContextStorageDir(), "context.db"),
    ].filter((path): path is string => typeof path === "string" && path.trim().length > 0);
    return [...new Set(paths.map((path) => resolve(path)))];
}

function discoverSourceDbPath(explicit?: string): string {
    for (const path of candidateSourcePaths(explicit)) {
        if (existsSync(path)) return path;
    }
    throw new Error(
        `No legacy Magic Context database found. Pass /mc-import-context <path> or set MC_IMPORT_SOURCE_DB. Checked: ${candidateSourcePaths(explicit).join(", ")}`,
    );
}

function hasTable(db: SqliteDatabase, table: string): boolean {
    const row = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { present?: number } | null;
    return row?.present === 1;
}

function tableColumns(db: SqliteDatabase, table: string): string[] {
    if (!hasTable(db, table)) return [];
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function sharedColumns(
    source: SqliteDatabase,
    target: SqliteDatabase,
    table: string,
    omitted: ReadonlySet<string>,
): string[] {
    const targetColumns = new Set(tableColumns(target, table));
    return tableColumns(source, table).filter(
        (column) => targetColumns.has(column) && !omitted.has(column),
    );
}

function quotedIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
}

function selectRows(db: SqliteDatabase, table: string, where: string, ...args: unknown[]): Row[] {
    if (!hasTable(db, table)) return [];
    return db.prepare(`SELECT * FROM ${quotedIdentifier(table)} ${where}`).all(...args) as Row[];
}

function insertRow(
    db: SqliteDatabase,
    table: string,
    columns: string[],
    row: Row,
    overrides: Row = {},
): { changes: number; lastInsertRowid: number } {
    const names = columns.map(quotedIdentifier).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const values = columns.map((column) =>
        Object.hasOwn(overrides, column) ? overrides[column] : (row[column] ?? null),
    );
    const result = db
        .prepare(
            `INSERT OR IGNORE INTO ${quotedIdentifier(table)} (${names}) VALUES (${placeholders})`,
        )
        .run(...values) as { changes?: number | bigint; lastInsertRowid?: number | bigint };
    const id = result.lastInsertRowid;
    const changes = result.changes;
    return {
        changes:
            typeof changes === "bigint"
                ? Number(changes)
                : typeof changes === "number"
                  ? changes
                  : 0,
        lastInsertRowid: typeof id === "bigint" ? Number(id) : typeof id === "number" ? id : 0,
    };
}

function copyCompartments(
    source: SqliteDatabase,
    target: SqliteDatabase,
    sessionId: string,
): { inserted: number; idMap: Map<number, number> } {
    const rows = selectRows(
        source,
        "compartments",
        "WHERE session_id = ? ORDER BY sequence ASC",
        sessionId,
    );
    const columns = sharedColumns(source, target, "compartments", new Set(["id"]));
    const idMap = new Map<number, number>();
    let inserted = 0;
    for (const row of rows) {
        const oldId = typeof row.id === "number" ? row.id : Number(row.id);
        const insert = insertRow(target, "compartments", columns, row);
        if (Number.isFinite(oldId) && insert.lastInsertRowid > 0) {
            idMap.set(oldId, insert.lastInsertRowid);
        }
        inserted += insert.changes;
    }
    return { inserted, idMap };
}

function copyRowsBySession(
    source: SqliteDatabase,
    target: SqliteDatabase,
    table: string,
    sessionId: string,
    overrides: Row = {},
): number {
    const rows = selectRows(source, table, "WHERE session_id = ?", sessionId);
    const columns = sharedColumns(source, target, table, new Set(["id"]));
    let inserted = 0;
    for (const row of rows) {
        const insert = insertRow(target, table, columns, row, overrides);
        inserted += insert.changes;
    }
    return inserted;
}

function resolveImportProjectIdentity(projectPath: string | undefined): string | undefined {
    if (!projectPath) return undefined;
    if (projectPath.startsWith("git:") || projectPath.startsWith("dir:")) return projectPath;
    return resolveProjectIdentity(projectPath);
}

function copyChunkEmbeddings(
    source: SqliteDatabase,
    target: SqliteDatabase,
    sessionId: string,
    idMap: Map<number, number>,
    projectPath?: string,
): number {
    const rows = selectRows(
        source,
        "compartment_chunk_embeddings",
        "WHERE session_id = ?",
        sessionId,
    );
    const columns = sharedColumns(source, target, "compartment_chunk_embeddings", new Set(["id"]));
    const harness = getHarness();
    let inserted = 0;
    for (const row of rows) {
        const sourceCompartmentId =
            typeof row.compartment_id === "number" ? row.compartment_id : null;
        const targetCompartmentId =
            sourceCompartmentId === null ? null : idMap.get(sourceCompartmentId);
        if (!targetCompartmentId) continue;
        const insert = insertRow(target, "compartment_chunk_embeddings", columns, row, {
            compartment_id: targetCompartmentId,
            project_path: projectPath ?? row.project_path,
            harness,
        });
        inserted += insert.changes;
    }
    return inserted;
}

function ensureTargetSessionProject(
    db: SqliteDatabase,
    sessionId: string,
    projectIdentity: string | undefined,
    directory: string | undefined,
): number {
    if (!projectIdentity || !hasTable(db, "session_projects")) return 0;
    const now = Date.now();
    const result = db
        .prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, directory, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, harness) DO UPDATE SET
                 project_path = excluded.project_path,
                 directory = excluded.directory,
                 updated_at = excluded.updated_at`,
        )
        .run(sessionId, getHarness(), projectIdentity, directory ?? null, now, now) as {
        changes?: number | bigint;
    };
    const changes = result.changes;
    return typeof changes === "bigint"
        ? Number(changes)
        : typeof changes === "number"
          ? changes
          : 0;
}

function targetAlreadyHasSession(target: SqliteDatabase, sessionId: string): boolean {
    const row = target
        .prepare("SELECT 1 AS present FROM compartments WHERE session_id = ? LIMIT 1")
        .get(sessionId) as { present?: number } | null;
    return row?.present === 1;
}

function rebuildMessageIndex(
    db: SqliteDatabase,
    sessionId: string,
    readRawMessages: (sessionId: string) => RawMessage[],
): number {
    const messages = readRawMessages(sessionId);
    clearIndexedMessages(db, sessionId);
    if (messages.length === 0) return 0;
    const finalWatermark = messages.reduce((max, message) => Math.max(max, message.ordinal), 0);
    return indexMessagesAfterOrdinal(db, sessionId, messages, 0, finalWatermark);
}

export function importLegacySessionContext(
    options: ImportLegacySessionOptions,
): ImportLegacySessionResult {
    const sourceDbPath = discoverSourceDbPath(options.sourceDbPath);
    const projectIdentity = resolveImportProjectIdentity(options.projectPath);
    const sourceDb = new Database(sourceDbPath, { readonly: true });
    try {
        const hasExistingSession = targetAlreadyHasSession(options.targetDb, options.sessionId);
        if (hasExistingSession) {
            const indexedMessages = rebuildMessageIndex(
                options.targetDb,
                options.sessionId,
                options.readRawMessages,
            );
            return {
                sourceDbPath,
                compartments: 0,
                chunkEmbeddings: 0,
                sessionProjects: 0,
                indexedMessages,
                status: "already_imported",
            };
        }

        let result: ImportLegacySessionResult | null = null;
        options.targetDb.exec("BEGIN IMMEDIATE");
        let committed = false;
        try {
            const { inserted: compartments, idMap } = copyCompartments(
                sourceDb,
                options.targetDb,
                options.sessionId,
            );
            const chunkEmbeddings = copyChunkEmbeddings(
                sourceDb,
                options.targetDb,
                options.sessionId,
                idMap,
                projectIdentity,
            );
            const copiedSessionProjects = copyRowsBySession(
                sourceDb,
                options.targetDb,
                "session_projects",
                options.sessionId,
                projectIdentity
                    ? {
                          project_path: projectIdentity,
                          directory: options.projectPath ?? null,
                          harness: getHarness(),
                      }
                    : {},
            );
            const ensuredSessionProjects = ensureTargetSessionProject(
                options.targetDb,
                options.sessionId,
                projectIdentity,
                options.projectPath,
            );
            const sessionProjects = Math.max(copiedSessionProjects, ensuredSessionProjects);
            options.targetDb.exec("COMMIT");
            committed = true;
            const indexedMessages = rebuildMessageIndex(
                options.targetDb,
                options.sessionId,
                options.readRawMessages,
            );
            result = {
                sourceDbPath,
                compartments,
                chunkEmbeddings,
                sessionProjects,
                indexedMessages,
                status: "imported",
            };
        } finally {
            if (!committed) {
                try {
                    options.targetDb.exec("ROLLBACK");
                } catch (error) {
                    log(
                        `[mc-import-context] rollback failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
        }

        if (!result) throw new Error("Import failed before producing a result.");
        return result;
    } finally {
        closeQuietly(sourceDb);
    }
}

export function formatImportLegacySessionResult(result: ImportLegacySessionResult): string {
    return [
        result.status === "already_imported"
            ? "## Magic Context Import\n\nSession context was already imported; message search index was refreshed."
            : "## Magic Context Import\n\nImported legacy session context into mini-magic-context.",
        "",
        `Source DB: ${result.sourceDbPath}`,
        `Compartments: ${result.compartments}`,
        `Chunk embeddings: ${result.chunkEmbeddings}`,
        `Session projects: ${result.sessionProjects}`,
        `Indexed messages: ${result.indexedMessages}`,
    ].join("\n");
}

export function parseImportSourceArg(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    return resolve(trimmed);
}
