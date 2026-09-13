import type { Database } from "../../shared/sqlite";

export const MINI_SCHEMA_VERSION = 1;
const MINI_SCHEMA_FINGERPRINT = "mini-v1-clean-start";
const MINI_SCHEMA_TABLE = "mini_schema";

function listUserTables(db: Database): Array<{ name: string }> {
    return db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
}

export function classifyMiniDatabase(db: Database): "fresh" | "current" | "unsupported" {
    const tables = listUserTables(db);
    if (tables.length === 0) return "fresh";
    if (!tables.some((table) => table.name === MINI_SCHEMA_TABLE)) return "unsupported";
    try {
        const row = db
            .prepare("SELECT version, schema_fingerprint FROM mini_schema LIMIT 1")
            .get() as { version?: unknown; schema_fingerprint?: unknown } | undefined;
        return row?.version === MINI_SCHEMA_VERSION &&
            row.schema_fingerprint === MINI_SCHEMA_FINGERPRINT
            ? "current"
            : "unsupported";
    } catch {
        return "unsupported";
    }
}

export function initializeMiniDatabase(db: Database): void {
    db.exec(`
CREATE TABLE compartment_chunk_embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, compartment_id INTEGER NOT NULL, session_id TEXT NOT NULL, project_path TEXT NOT NULL, harness TEXT NOT NULL DEFAULT 'pi', window_index INTEGER NOT NULL DEFAULT 0, start_ordinal INTEGER NOT NULL, end_ordinal INTEGER NOT NULL, chunk_hash TEXT NOT NULL, model_id TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL, created_at INTEGER NOT NULL, UNIQUE(compartment_id, model_id, window_index));

CREATE TABLE compartment_state_lease (session_id TEXT PRIMARY KEY, holder_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE compartments (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, start_message INTEGER NOT NULL, end_message INTEGER NOT NULL, start_message_id TEXT NOT NULL, end_message_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, p1 TEXT NOT NULL, p2 TEXT, p3 TEXT, p4 TEXT, importance INTEGER NOT NULL DEFAULT 50, episode_type TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, harness TEXT NOT NULL DEFAULT 'pi', UNIQUE(session_id, sequence));

CREATE TABLE compression_depth (session_id TEXT NOT NULL, message_ordinal INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0, harness TEXT NOT NULL DEFAULT 'pi', PRIMARY KEY(session_id, message_ordinal));

CREATE TABLE embedding_identity_active (project_path TEXT NOT NULL, scope TEXT NOT NULL, model_id TEXT NOT NULL, last_active_at INTEGER NOT NULL, PRIMARY KEY(project_path, scope, model_id));

CREATE TABLE embedding_registrations (project_path TEXT PRIMARY KEY, source_directory TEXT NOT NULL DEFAULT '', provider_identity TEXT NOT NULL, model_id TEXT NOT NULL, chunk_model_id TEXT NOT NULL, runtime_fingerprint TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', table_epoch INTEGER NOT NULL DEFAULT 0, dims INTEGER NOT NULL DEFAULT 0, provenance_json TEXT NOT NULL DEFAULT '{}', generation INTEGER NOT NULL, features_json TEXT NOT NULL DEFAULT '{}', config_json TEXT NOT NULL DEFAULT '{}', observation_mode INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);

CREATE TABLE m0_mutation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, mutation_type TEXT NOT NULL, target_id INTEGER, queued_at INTEGER NOT NULL);

CREATE TABLE message_history_index (session_id TEXT PRIMARY KEY, last_indexed_ordinal INTEGER NOT NULL DEFAULT 0, dirty_floor_ordinal INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, harness TEXT NOT NULL DEFAULT 'pi');

CREATE TABLE message_history_orphan_sweep (harness TEXT PRIMARY KEY, cursor_session_id TEXT NOT NULL DEFAULT '', last_swept_at INTEGER);

CREATE TABLE message_history_source (session_id TEXT NOT NULL, message_id TEXT NOT NULL, message_ordinal INTEGER NOT NULL, source_version TEXT NOT NULL, normalized_content_hash TEXT NOT NULL, role TEXT NOT NULL, harness TEXT NOT NULL DEFAULT 'pi', updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, message_id));

CREATE TABLE mini_schema (
  version INTEGER PRIMARY KEY CHECK(version = 1),
  schema_fingerprint TEXT NOT NULL CHECK(schema_fingerprint = 'mini-v1-clean-start')
);
INSERT OR IGNORE INTO mini_schema(version, schema_fingerprint) VALUES (1, 'mini-v1-clean-start');

CREATE TABLE pending_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tag_id INTEGER NOT NULL, operation TEXT NOT NULL, queued_at INTEGER NOT NULL, harness TEXT NOT NULL DEFAULT 'pi');

CREATE TABLE pending_session_cleanup (session_id TEXT PRIMARY KEY, harness TEXT NOT NULL DEFAULT 'pi', requested_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER);

CREATE TABLE recomp_compartments (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, start_message INTEGER NOT NULL, end_message INTEGER NOT NULL, start_message_id TEXT DEFAULT '', end_message_id TEXT DEFAULT '', title TEXT NOT NULL, content TEXT NOT NULL, p1 TEXT, p2 TEXT, p3 TEXT, p4 TEXT, importance INTEGER NOT NULL DEFAULT 50, episode_type TEXT, pass_number INTEGER NOT NULL, created_at INTEGER NOT NULL, harness TEXT NOT NULL DEFAULT 'pi', UNIQUE(session_id, sequence));

CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY, harness TEXT NOT NULL DEFAULT 'pi', last_response_time INTEGER NOT NULL DEFAULT 0, cache_ttl TEXT NOT NULL DEFAULT '5m', counter INTEGER DEFAULT 0, last_emergency_input_sample INTEGER DEFAULT 0, last_transform_error TEXT DEFAULT '', auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]', cleared_reasoning_through_tag INTEGER DEFAULT 0, is_subagent INTEGER DEFAULT 0, last_context_percentage REAL DEFAULT 0, last_input_tokens INTEGER DEFAULT 0, observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0, cache_alert_sent INTEGER NOT NULL DEFAULT 0, times_execute_threshold_reached INTEGER DEFAULT 0, compartment_in_progress INTEGER DEFAULT 0, historian_failure_count INTEGER DEFAULT 0, historian_last_error TEXT DEFAULT NULL, historian_last_failure_at INTEGER DEFAULT NULL, system_prompt_hash TEXT DEFAULT '', system_prompt_tokens INTEGER NOT NULL DEFAULT 0, conversation_tokens INTEGER NOT NULL DEFAULT 0, tool_call_tokens INTEGER NOT NULL DEFAULT 0, tool_reclaim_watermark INTEGER NOT NULL DEFAULT 0, memory_block_cache TEXT DEFAULT '', memory_block_count INTEGER DEFAULT 0, memory_block_ids TEXT DEFAULT '', compaction_marker_state TEXT DEFAULT '', pending_compaction_marker_state TEXT, compaction_marker_target_end_message_id TEXT, pending_pi_compaction_marker_state TEXT, new_work_tokens INTEGER NOT NULL DEFAULT 0, total_input_tokens INTEGER NOT NULL DEFAULT 0, deferred_execute_state TEXT, cached_m0_bytes BLOB, cached_m0_project_memory_epoch INTEGER, cached_m0_workspace_fingerprint TEXT, cached_m0_project_user_profile_version INTEGER, cached_m0_max_compartment_seq INTEGER, cached_m0_max_memory_id INTEGER, cached_m0_max_mutation_id INTEGER, cached_m0_max_memory_mutation_id INTEGER, cached_m0_project_docs_hash TEXT, cached_m1_bytes BLOB, last_observed_model_key TEXT, last_usage_context_limit INTEGER NOT NULL DEFAULT 0, prior_boundary_ordinal INTEGER NOT NULL DEFAULT 1, protected_tail_policy_version INTEGER NOT NULL DEFAULT 0, protected_tail_drain_window_started_at INTEGER NOT NULL DEFAULT 0, protected_tail_drain_tokens INTEGER NOT NULL DEFAULT 0, recovery_no_eligible_head_count INTEGER NOT NULL DEFAULT 0, force_emergency_bypass_window_start INTEGER NOT NULL DEFAULT 0, force_emergency_bypass_used INTEGER NOT NULL DEFAULT 0, emergency_drain_active INTEGER NOT NULL DEFAULT 0, historian_drain_failure_at INTEGER NOT NULL DEFAULT 0, recomp_partial_range_start INTEGER NOT NULL DEFAULT 0, recomp_partial_range_end INTEGER NOT NULL DEFAULT 0, wrapup_in_progress_state TEXT, detected_context_limit INTEGER NOT NULL DEFAULT 0, detected_context_limit_model_key TEXT, needs_emergency_recovery INTEGER NOT NULL DEFAULT 0, emergency_recovery_origin TEXT NOT NULL DEFAULT '', stripped_placeholder_ids TEXT NOT NULL DEFAULT '[]', processed_image_stripped_ids TEXT NOT NULL DEFAULT '[]', session_facts_version INTEGER NOT NULL DEFAULT 0, cached_m0_materialized_at INTEGER, cached_m0_session_facts_version INTEGER, cached_m0_compartment_render_epoch TEXT, cached_m0_system_hash TEXT, cached_m0_model_key TEXT, cached_m0_project_identity TEXT, cached_m0_last_baseline_end_message_id TEXT
    );

CREATE TABLE session_projects (session_id TEXT NOT NULL, harness TEXT NOT NULL DEFAULT 'pi', project_path TEXT NOT NULL, directory TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, harness));

CREATE TABLE source_contents (tag_id INTEGER NOT NULL, session_id TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000), harness TEXT NOT NULL DEFAULT 'pi', PRIMARY KEY(session_id, tag_id));

CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      input_byte_size INTEGER NOT NULL DEFAULT 0,
      reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
      tag_number INTEGER,
      tool_name TEXT,
      harness TEXT NOT NULL DEFAULT 'pi',
      entry_fingerprint TEXT,
      token_count INTEGER,
      input_token_count INTEGER,
      reasoning_token_count INTEGER,
      call_id TEXT,
      tool_owner_message_id TEXT,
      dropped_at INTEGER,
      drop_mode TEXT,
      caveman_depth INTEGER DEFAULT 0,
      file_path TEXT,
      part_index INTEGER,
      UNIQUE(session_id, tag_number)
    );

CREATE INDEX idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);

CREATE INDEX idx_cce_session ON compartment_chunk_embeddings(session_id);

CREATE INDEX idx_compartments_session_range ON compartments(session_id, start_message, end_message);

CREATE INDEX idx_m0_mutation_log_session ON m0_mutation_log(session_id, id);

CREATE INDEX idx_pending_ops_session ON pending_ops(session_id);

CREATE INDEX idx_source_contents_session ON source_contents(session_id);

CREATE INDEX idx_tags_session_status ON tags(session_id, status);

CREATE INDEX idx_tags_session_tag_number ON tags(session_id, tag_number);

CREATE UNIQUE INDEX idx_tags_tool_composite ON tags(session_id, message_id, tool_owner_message_id) WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;

    `);
    try {
        db.exec(
            `CREATE VIRTUAL TABLE message_history_fts USING fts5(session_id UNINDEXED, message_ordinal UNINDEXED, message_id UNINDEXED, role UNINDEXED, content, tokenize = 'porter unicode61');`,
        );
    } catch {
        // FTS5 is optional. Text search reports unavailable when SQLite lacks it.
    }
}
