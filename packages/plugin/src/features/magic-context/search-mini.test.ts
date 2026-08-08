import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    _resetProjectEmbeddingRegistryForTests,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import { unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

describe("unifiedSearch mini source clamp", () => {
    let db: Database | null = null;

    afterEach(() => {
        if (db) closeQuietly(db);
        db = null;
        _resetProjectEmbeddingRegistryForTests();
    });

    it("ignores removed source requests without touching dropped tables", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);

        const results = await unifiedSearch(db, "ses-mini", "/repo/project", "alpha", {
            sources: ["memory", "note", "git_commit", "primer"] as never,
            embeddingEnabled: false,
        });

        // Removed sources resolve to nothing; no dropped table is queried.
        expect(results).toEqual([]);
    });

    it("defaults to message-only search when sources is omitted", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);

        const results = await unifiedSearch(db, "ses-mini", "/repo/project", "alpha", {
            embeddingEnabled: false,
        });

        // No message_history_fts rows exist, so the journal lane is empty.
        expect(results).toEqual([]);
    });

    it("performs message FTS with no semantic query when the provider is 'off'", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        registerProjectEmbedding(
            db,
            "/repo/off",
            { provider: "off" },
            { memoryEnabled: false, gitCommitEnabled: false },
            "/repo/off",
        );
        db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        ).run("ses-off", 1, "ses-off-u1", "user", "How do we avoid saturating the queue?");
        db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        ).run("ses-off", 2, "ses-off-a2", "assistant", "Use backpressure and bounded drains.");

        const results = await unifiedSearch(db, "ses-off", "/repo/off", "backpressure", {
            embeddingEnabled: false,
            sources: ["message"],
        });

        const messages = results.filter((r) => r.source === "message");
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.some((r) => r.messageId === "ses-off-a2")).toBe(true);
    });
});
