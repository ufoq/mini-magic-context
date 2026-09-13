/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { appendAutoSearchHintDecision } from "./storage-meta-persisted";

function createRaceDb(path: string): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("sticky-injection CAS helpers", () => {
    it("auto-search already-present outcome returns stored decision", () => {
        const dir = mkdtempSync(join(tmpdir(), "sticky-auto-stored-"));
        try {
            const path = join(dir, "context.db");
            const db = createRaceDb(path);
            const stored = { messageId: "m1", decision: "hint" as const, text: "STORED" };
            expect(appendAutoSearchHintDecision(db, "s1", stored)).toEqual({
                ok: true,
                kind: "appended",
                decision: stored,
            });
            expect(
                appendAutoSearchHintDecision(db, "s1", {
                    messageId: "m1",
                    decision: "no-hint",
                    reason: "stacked",
                }),
            ).toEqual({ ok: true, kind: "already-present", decision: stored });
        } finally {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
    });
});
