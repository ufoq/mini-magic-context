import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { replaceAllCompartments } from "./compartment-storage";
import { closeDatabase, openDatabase, openDatabaseAsync } from "./storage-db";
import { clearSession, getOrCreateSessionMeta } from "./storage-meta-session";

const tempDirs: string[] = [];

function createDatabasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), "mini-schema-lifecycle-"));
    tempDirs.push(directory);
    return join(directory, "context.db");
}

function requireDatabase(db: ReturnType<typeof openDatabase>) {
    if (db === null) throw new Error("expected mini database to open");
    return db;
}

afterEach(() => {
    closeDatabase();
    for (const directory of tempDirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("mini database lifecycle", () => {
    test("creates exactly the mini schema and its runtime columns", () => {
        const db = requireDatabase(openDatabase(createDatabasePath()));
        const tables = (
            db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                )
                .all() as Array<{ name: string }>
        )
            .map((row) => row.name)
            .sort();

        expect(tables).toEqual([
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
            "tags",
        ]);

        const tagColumns = db.prepare("PRAGMA table_info(tags)").all() as Array<{ name: string }>;
        expect(tagColumns.map((column) => column.name)).toEqual(
            expect.arrayContaining([
                "session_id",
                "tag_number",
                "tool_owner_message_id",
                "harness",
            ]),
        );
        const metaColumns = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
            name: string;
        }>;
        expect(metaColumns.map((column) => column.name)).toEqual(
            expect.arrayContaining(["session_id", "harness", "counter", "compartment_in_progress"]),
        );
        expect(db.prepare("SELECT version FROM mini_schema").get()).toEqual({ version: 1 });
    });

    test("persists historian and tag state, clears the session, then reopens", async () => {
        const dbPath = createDatabasePath();
        const db = await openDatabaseAsync(dbPath);
        if (db === null) throw new Error("expected mini database to open asynchronously");
        const sessionId = "ses-mini-lifecycle";

        getOrCreateSessionMeta(db, sessionId);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, tag_number, harness) VALUES (?, ?, ?, ?, ?)",
        ).run(sessionId, "msg-1", "message", 1, "opencode");
        replaceAllCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "msg-1",
                endMessageId: "msg-2",
                title: "Historian output",
                content: "A compacted history block.",
            },
        ]);

        clearSession(db, sessionId);
        closeDatabase();

        const reopened = requireDatabase(openDatabase(dbPath));
        expect(
            reopened
                .prepare("SELECT COUNT(*) AS count FROM tags WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ count: 0 });
        expect(
            reopened
                .prepare("SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ count: 0 });
        expect(
            reopened
                .prepare("SELECT COUNT(*) AS count FROM session_meta WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ count: 0 });
    });

    test("refuses an unmarked legacy database without changing it", () => {
        const dbPath = createDatabasePath();
        const legacy = new Database(dbPath);
        legacy.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT)");
        closeQuietly(legacy);

        expect(openDatabase(dbPath)).toBeNull();
        const unchanged = new Database(dbPath);
        try {
            expect(
                unchanged
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                    .all(),
            ).toEqual([{ name: "memories" }]);
        } finally {
            closeQuietly(unchanged);
        }
    });
});
