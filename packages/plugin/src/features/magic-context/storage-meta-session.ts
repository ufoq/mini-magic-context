import { Buffer } from "node:buffer";
import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";
import { clearCompressionDepth } from "./compression-depth-storage";
import { clearIndexedMessages } from "./message-index";
import {
    BOOLEAN_META_KEYS,
    ensureSessionMetaRow,
    getDefaultSessionMeta,
    isSessionMetaRow,
    META_COLUMNS,
    NULL_BIND_META_KEYS,
    SESSION_META_SELECT_COLUMNS,
    toSessionMeta,
} from "./storage-meta-shared";
import type { SessionMeta } from "./types";

const SESSION_META_SELECT_SQL = SESSION_META_SELECT_COLUMNS.join(", ");

export function getOrCreateSessionMeta(db: Database, sessionId: string): SessionMeta {
    const result = db
        .prepare(`SELECT ${SESSION_META_SELECT_SQL} FROM session_meta WHERE session_id = ?`)
        .get(sessionId);

    if (isSessionMetaRow(result)) {
        return toSessionMeta(result);
    }

    if (result !== undefined && result !== null) {
        throw new Error(`invalid session_meta row for ${sessionId}`);
    }
    const defaults = getDefaultSessionMeta(sessionId);
    ensureSessionMetaRow(db, sessionId);
    return defaults;
}

export function updateSessionMeta(
    db: Database,
    sessionId: string,
    updates: Partial<SessionMeta>,
): void {
    const setClauses: string[] = [];
    const values: Array<string | number | Buffer | null> = [];

    for (const [key, column] of Object.entries(META_COLUMNS)) {
        const value = updates[key as keyof SessionMeta];
        if (value === undefined) continue;

        if (value === null) {
            setClauses.push(`${column} = ?`);
            values.push(NULL_BIND_META_KEYS.has(key) ? null : "");
        } else if (
            (key === "cachedM0Bytes" || key === "cachedM1Bytes") &&
            value instanceof Uint8Array
        ) {
            setClauses.push(`${column} = ?`);
            values.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        } else if (BOOLEAN_META_KEYS.has(key)) {
            setClauses.push(`${column} = ?`);
            values.push(value ? 1 : 0);
        } else if (typeof value === "string" || typeof value === "number") {
            setClauses.push(`${column} = ?`);
            values.push(value);
        }
    }

    if (setClauses.length === 0) {
        return;
    }

    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")} WHERE session_id = ?`).run(
            ...values,
            sessionId,
        );
    })();
}

export function advanceToolReclaimWatermark(
    db: Database,
    sessionId: string,
    maxTagNumber: number,
): void {
    if (maxTagNumber <= 0) return;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET tool_reclaim_watermark = MAX(COALESCE(tool_reclaim_watermark, 0), ?) WHERE session_id = ?",
        ).run(maxTagNumber, sessionId);
    })();
}

export interface PendingSessionCleanupRetryResult {
    attempted: number;
    cleared: number;
    failedSessionIds: string[];
}

export function markSessionCleanupPending(db: Database, sessionId: string): void {
    db.prepare(
        `INSERT INTO pending_session_cleanup (session_id, harness, requested_at, last_attempt_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
             harness = excluded.harness,
             requested_at = MIN(pending_session_cleanup.requested_at, excluded.requested_at)`,
    ).run(sessionId, getHarness(), Date.now());
}

export function retryPendingSessionCleanups(
    db: Database,
    limit = 200,
): PendingSessionCleanupRetryResult {
    const rows = db
        .prepare(
            "SELECT session_id FROM pending_session_cleanup ORDER BY requested_at ASC, session_id ASC LIMIT ?",
        )
        .all(Math.max(1, Math.floor(limit))) as Array<{ session_id: string }>;
    const failedSessionIds: string[] = [];
    let cleared = 0;
    for (const row of rows) {
        try {
            db.prepare(
                "UPDATE pending_session_cleanup SET last_attempt_at = ? WHERE session_id = ?",
            ).run(Date.now(), row.session_id);
            clearSession(db, row.session_id);
            cleared += 1;
        } catch {
            failedSessionIds.push(row.session_id);
        }
    }
    return { attempted: rows.length, cleared, failedSessionIds };
}

export function clearSession(db: Database, sessionId: string): void {
    // Every session-scoped table must be cleared here; the structural storage-db
    // test discovers tables with session_id and seeds each one to enforce this list.
    db.transaction(() => {
        db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM source_contents WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM tags WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_meta WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_projects WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM compartment_chunk_embeddings WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        clearCompressionDepth(db, sessionId);
        db.prepare("DELETE FROM compartment_state_lease WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM m0_mutation_log WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM pending_session_cleanup WHERE session_id = ?").run(sessionId);
        clearIndexedMessages(db, sessionId);
    })();
}
