import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { resolveProjectIdentity } from "./memory/project-identity";
import { importLegacySessionContext } from "./slim-import";
import { type ContextDatabase, openDatabase } from "./storage-db";

describe("importLegacySessionContext", () => {
    const tmpRoots: string[] = [];
    const dbs: ContextDatabase[] = [];

    afterEach(() => {
        for (const db of dbs.splice(0)) closeQuietly(db);
        for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function tempDb(name: string): { db: ContextDatabase; path: string } {
        const root = mkdtempSync(join(tmpdir(), `mc-mini-import-${name}-`));
        tmpRoots.push(root);
        const path = join(root, "context.db");
        const db = openDatabase({ dbPath: path });
        if (!db) throw new Error("failed to open test database");
        dbs.push(db);
        return { db, path };
    }

    test("copies retained session tables and rebuilds message FTS", () => {
        const source = tempDb("source");
        const target = tempDb("target");
        const sessionId = "ses-import";
        const now = Date.now();
        const rawProjectDir = mkdtempSync(join(tmpdir(), "mc-mini-import-project-"));
        tmpRoots.push(rawProjectDir);
        const resolvedProject = resolveProjectIdentity(rawProjectDir);

        source.db
            .prepare(
                `INSERT INTO compartments (
                    session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content,
                    p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                sessionId,
                1,
                1,
                2,
                "u1",
                "a1",
                "Imported",
                "full content",
                "tier one",
                "tier two",
                "tier three",
                "tier four",
                77,
                "feature",
                0,
                now,
                "opencode",
            );
        const sourceCompartmentId = Number(
            (
                source.db
                    .prepare("SELECT id FROM compartments WHERE session_id = ?")
                    .get(sessionId) as { id: number }
            ).id,
        );
        source.db
            .prepare(
                `INSERT INTO compartment_chunk_embeddings (
                    compartment_id, session_id, project_path, harness, window_index,
                    start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                sourceCompartmentId,
                sessionId,
                "/legacy/project",
                "opencode",
                0,
                1,
                2,
                "hash",
                "model",
                1,
                new Uint8Array([0, 0, 128, 63]),
                now,
            );
        source.db
            .prepare(
                "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run(sessionId, "opencode", "/legacy/project", now);
        const messages: RawMessage[] = [
            {
                id: "u1",
                ordinal: 1,
                role: "user",
                parts: [{ type: "text", text: "please import this history" }],
            },
            {
                id: "a1",
                ordinal: 2,
                role: "assistant",
                parts: [{ type: "text", text: "history imported" }],
            },
        ];

        const result = importLegacySessionContext({
            targetDb: target.db,
            sessionId,
            sourceDbPath: source.path,
            projectPath: rawProjectDir,
            readRawMessages: () => messages,
        });

        expect(result.status).toBe("imported");
        expect(result.compartments).toBe(1);
        expect(result.chunkEmbeddings).toBe(1);
        expect(result.sessionProjects).toBe(1);
        expect(result.indexedMessages).toBe(2);
        expect(
            (
                target.db
                    .prepare("SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?")
                    .get(sessionId) as { count: number }
            ).count,
        ).toBe(1);
        expect(
            (
                target.db
                    .prepare(
                        "SELECT project_path AS projectPath FROM compartment_chunk_embeddings WHERE session_id = ?",
                    )
                    .get(sessionId) as { projectPath: string }
            ).projectPath,
        ).toBe(resolvedProject);
        expect(
            (
                target.db
                    .prepare(
                        "SELECT project_path AS projectPath, directory FROM session_projects WHERE session_id = ?",
                    )
                    .get(sessionId) as { projectPath: string; directory: string }
            ).projectPath,
        ).toBe(resolvedProject);
        expect(
            (
                target.db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ?",
                    )
                    .get(sessionId) as { count: number }
            ).count,
        ).toBe(2);
    });

    test("creates a session project mapping when the legacy database lacks one", () => {
        const source = tempDb("source-no-project");
        const target = tempDb("target-no-project");
        const sessionId = "ses-import-no-project";
        const rawProjectDir = mkdtempSync(join(tmpdir(), "mc-mini-import-project-missing-"));
        tmpRoots.push(rawProjectDir);
        const resolvedProject = resolveProjectIdentity(rawProjectDir);

        source.db
            .prepare(
                `INSERT INTO compartments (
                    session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content,
                    p1, created_at, harness
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                sessionId,
                1,
                1,
                2,
                "u1",
                "a1",
                "Imported",
                "content",
                "content",
                Date.now(),
                "opencode",
            );

        const result = importLegacySessionContext({
            targetDb: target.db,
            sessionId,
            sourceDbPath: source.path,
            projectPath: rawProjectDir,
            readRawMessages: () => [],
        });

        expect(result.sessionProjects).toBe(1);
        expect(
            (
                target.db
                    .prepare(
                        "SELECT project_path AS projectPath FROM session_projects WHERE session_id = ?",
                    )
                    .get(sessionId) as { projectPath: string }
            ).projectPath,
        ).toBe(resolvedProject);
    });
});
