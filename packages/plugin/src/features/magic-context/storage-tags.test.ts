/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getOldestActiveUnprotectedToolTags, insertTag } from "./storage-tags";

let db: Database;

function makeMemoryDatabase(): Database {
    const d = new Database(":memory:");
    d.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      drop_mode TEXT DEFAULT 'full',
      tool_name TEXT,
      input_byte_size INTEGER DEFAULT 0,
      byte_size INTEGER,
      tag_number INTEGER NOT NULL,
      reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
      caveman_depth INTEGER NOT NULL DEFAULT 0,
            harness TEXT NOT NULL DEFAULT 'opencode',
      tool_owner_message_id TEXT DEFAULT NULL,
      entry_fingerprint TEXT,
      token_count INTEGER,
      input_token_count INTEGER,
      reasoning_token_count INTEGER,
      UNIQUE(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_transform_error TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash INTEGER DEFAULT 0,
      system_prompt_tokens INTEGER DEFAULT 0,
      conversation_tokens INTEGER DEFAULT 0,
      tool_call_tokens INTEGER DEFAULT 0,
      cleared_reasoning_through_tag INTEGER DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return d;
}

afterEach(() => {
    if (db) closeQuietly(db);
});

describe("storage-tags", () => {
    describe("#given insertTag", () => {
        it("#when inserting a valid tag #then returns the row id", () => {
            db = makeMemoryDatabase();
            const id = insertTag(db, "ses-1", "msg-1", "message", 100, 1);

            expect(id).toBe(1);
            expect(typeof id).toBe("number");
        });

        it("#when inserting multiple tags #then returns incrementing ids", () => {
            db = makeMemoryDatabase();
            const id1 = insertTag(db, "ses-1", "msg-1", "message", 100, 1);
            const id2 = insertTag(db, "ses-1", "msg-2", "tool", 200, 2);

            expect(id1).toBe(1);
            expect(id2).toBe(2);
        });
    });

    describe("#given oldest reclaimable tool hint query", () => {
        it("#then returns oldest active unprotected tool tags using stored tool names", () => {
            db = makeMemoryDatabase();
            insertTag(db, "ses-hint", "msg-1", "tool", 100, 1, 0, "read");
            insertTag(db, "ses-hint", "msg-2", "message", 100, 2);
            insertTag(db, "ses-hint", "msg-3", "tool", 100, 3, 0, "grep");
            insertTag(db, "ses-hint", "msg-4", "tool", 100, 4, 0, null);
            insertTag(db, "ses-hint", "msg-5", "tool", 100, 5, 0, "bash");

            const hints = getOldestActiveUnprotectedToolTags(db, "ses-hint", 2, 4);

            expect(hints).toEqual([
                { tagNumber: 1, toolName: "read" },
                { tagNumber: 3, toolName: "grep" },
            ]);
        });
    });
});
