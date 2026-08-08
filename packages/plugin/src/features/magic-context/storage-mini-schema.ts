import type { Database } from "../../shared/sqlite";

export const MINI_SCHEMA_VERSION = 1;

const MINI_SCHEMA_TABLE = "mini_schema";

export function classifyMiniDatabase(db: Database): "fresh" | "current" | "unsupported" | "legacy" {
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
    if (tables.length === 0) return "fresh";
    if (!tables.some((table) => table.name === MINI_SCHEMA_TABLE)) return "legacy";
    const schema = db.prepare("SELECT version FROM mini_schema").get() as {
        version: number;
    } | null;
    return schema?.version === MINI_SCHEMA_VERSION ? "current" : "unsupported";
}

export function initializeMiniDatabase(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS mini_schema (version INTEGER PRIMARY KEY CHECK(version = ${MINI_SCHEMA_VERSION}));
        INSERT OR IGNORE INTO mini_schema(version) VALUES (${MINI_SCHEMA_VERSION});
        CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, message_id TEXT, type TEXT, status TEXT DEFAULT 'active', byte_size INTEGER, input_byte_size INTEGER NOT NULL DEFAULT 0, reasoning_byte_size INTEGER NOT NULL DEFAULT 0, tag_number INTEGER, tool_name TEXT, harness TEXT NOT NULL DEFAULT 'opencode', entry_fingerprint TEXT, token_count INTEGER, input_token_count INTEGER, reasoning_token_count INTEGER, call_id TEXT, tool_owner_message_id TEXT, dropped_at INTEGER, drop_mode TEXT, caveman_depth INTEGER DEFAULT 0, file_path TEXT, part_index INTEGER, UNIQUE(session_id, tag_number));
        CREATE INDEX IF NOT EXISTS idx_tags_session_status ON tags(session_id, status);
        CREATE INDEX IF NOT EXISTS idx_tags_session_tag_number ON tags(session_id, tag_number);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_tool_composite ON tags(session_id, message_id, tool_owner_message_id) WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_tags_tool_null_owner ON tags(session_id, message_id) WHERE type = 'tool' AND tool_owner_message_id IS NULL;
        CREATE TABLE IF NOT EXISTS pending_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tag_id INTEGER NOT NULL, operation TEXT NOT NULL, queued_at INTEGER NOT NULL, harness TEXT NOT NULL DEFAULT 'opencode');
        CREATE INDEX IF NOT EXISTS idx_pending_ops_session ON pending_ops(session_id);
        CREATE TABLE IF NOT EXISTS source_contents (tag_id INTEGER NOT NULL, session_id TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000), harness TEXT NOT NULL DEFAULT 'opencode', PRIMARY KEY(session_id, tag_id));
        CREATE INDEX IF NOT EXISTS idx_source_contents_session ON source_contents(session_id);
        CREATE TABLE IF NOT EXISTS compartments (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, start_message INTEGER NOT NULL, end_message INTEGER NOT NULL, start_message_id TEXT, end_message_id TEXT, title TEXT NOT NULL, content TEXT NOT NULL, p1 TEXT, p2 TEXT, p3 TEXT, p4 TEXT, importance INTEGER, episode_type TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0, harness TEXT NOT NULL DEFAULT 'opencode', UNIQUE(session_id, sequence));
        CREATE INDEX IF NOT EXISTS idx_compartments_session_range ON compartments(session_id, start_message, end_message);
        CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, compartment_id INTEGER NOT NULL, session_id TEXT NOT NULL, project_path TEXT NOT NULL, harness TEXT NOT NULL DEFAULT 'opencode', window_index INTEGER NOT NULL DEFAULT 0, start_ordinal INTEGER NOT NULL, end_ordinal INTEGER NOT NULL, chunk_hash TEXT NOT NULL, model_id TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL, created_at INTEGER NOT NULL, UNIQUE(compartment_id, model_id, window_index));
        CREATE INDEX IF NOT EXISTS idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);
        CREATE INDEX IF NOT EXISTS idx_cce_session ON compartment_chunk_embeddings(session_id);
        CREATE TABLE IF NOT EXISTS session_projects (session_id TEXT NOT NULL, harness TEXT NOT NULL DEFAULT 'opencode', project_path TEXT NOT NULL, directory TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, harness));
        CREATE TABLE IF NOT EXISTS compartment_state_lease (session_id TEXT PRIMARY KEY, holder_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS compression_depth (session_id TEXT NOT NULL, message_ordinal INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0, harness TEXT NOT NULL DEFAULT 'opencode', PRIMARY KEY(session_id, message_ordinal));
        CREATE TABLE IF NOT EXISTS m0_mutation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, mutation_type TEXT NOT NULL, target_id INTEGER, queued_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session ON m0_mutation_log(session_id, id);
        CREATE VIRTUAL TABLE IF NOT EXISTS message_history_fts USING fts5(session_id UNINDEXED, message_ordinal UNINDEXED, message_id UNINDEXED, role UNINDEXED, content, tokenize = 'porter unicode61');
        CREATE TABLE IF NOT EXISTS message_history_index (session_id TEXT PRIMARY KEY, last_indexed_ordinal INTEGER NOT NULL DEFAULT 0, dirty_floor_ordinal INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, harness TEXT NOT NULL DEFAULT 'opencode');
        CREATE TABLE IF NOT EXISTS message_history_source (session_id TEXT NOT NULL, message_id TEXT NOT NULL, message_ordinal INTEGER NOT NULL, source_version TEXT NOT NULL, normalized_content_hash TEXT NOT NULL, role TEXT NOT NULL, harness TEXT NOT NULL DEFAULT 'opencode', updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, message_id));
        CREATE TABLE IF NOT EXISTS pending_session_cleanup (session_id TEXT PRIMARY KEY, harness TEXT NOT NULL DEFAULT 'opencode', requested_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER);
        CREATE TABLE IF NOT EXISTS message_history_orphan_sweep (harness TEXT PRIMARY KEY, cursor_session_id TEXT NOT NULL DEFAULT '', last_swept_at INTEGER);
        CREATE TABLE IF NOT EXISTS session_meta (session_id TEXT PRIMARY KEY, harness TEXT NOT NULL DEFAULT 'opencode', last_response_time INTEGER, cache_ttl TEXT, counter INTEGER DEFAULT 0, last_nudge_tokens INTEGER DEFAULT 0, last_nudge_band TEXT DEFAULT '', last_nudge_undropped INTEGER DEFAULT 0, last_nudge_level TEXT DEFAULT '', last_transform_error TEXT DEFAULT '', is_subagent INTEGER DEFAULT 0, last_context_percentage REAL DEFAULT 0, last_input_tokens INTEGER DEFAULT 0, last_emergency_input_sample INTEGER DEFAULT 0, observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0, cache_alert_sent INTEGER NOT NULL DEFAULT 0, times_execute_threshold_reached INTEGER DEFAULT 0, compartment_in_progress INTEGER DEFAULT 0, historian_failure_count INTEGER DEFAULT 0, historian_last_error TEXT, historian_last_failure_at INTEGER, historian_drain_failure_at INTEGER DEFAULT 0, system_prompt_hash TEXT DEFAULT '', system_prompt_tokens INTEGER NOT NULL DEFAULT 0, conversation_tokens INTEGER NOT NULL DEFAULT 0, tool_call_tokens INTEGER NOT NULL DEFAULT 0, cleared_reasoning_through_tag INTEGER DEFAULT 0, tool_reclaim_watermark INTEGER NOT NULL DEFAULT 0, last_todo_state TEXT DEFAULT '', note_nudge_anchors TEXT NOT NULL DEFAULT '[]', stripped_placeholder_ids TEXT DEFAULT '[]', compaction_marker_state TEXT, needs_emergency_recovery INTEGER NOT NULL DEFAULT 0, emergency_recovery_origin TEXT, detected_context_limit INTEGER, detected_context_limit_model_key TEXT, cached_m0_bytes BLOB, cached_m0_mural_data_url TEXT, cached_m0_mural_hash TEXT, cached_m0_last_baseline_end_message_id TEXT, cached_m1_bytes BLOB, cached_m0_project_memory_epoch INTEGER, cached_m0_workspace_fingerprint TEXT, cached_m0_project_user_profile_version INTEGER, cached_m0_max_compartment_seq INTEGER, cached_m0_max_memory_id INTEGER, cached_m0_max_mutation_id INTEGER, cached_m0_max_memory_mutation_id INTEGER, cached_m0_project_docs_hash TEXT, cached_m0_materialized_at INTEGER, cached_m0_session_facts_version INTEGER, cached_m0_upgrade_state TEXT, cached_m0_system_hash TEXT, cached_m0_tool_set_hash TEXT, cached_m0_model_key TEXT, cached_m0_project_identity TEXT, last_observed_model_key TEXT, last_usage_context_limit INTEGER DEFAULT 0, prior_boundary_ordinal INTEGER DEFAULT 1, protected_tail_policy_version INTEGER DEFAULT 0, protected_tail_drain_window_started_at INTEGER DEFAULT 0, protected_tail_drain_tokens INTEGER DEFAULT 0, recovery_no_eligible_head_count INTEGER DEFAULT 0, force_emergency_bypass_window_start INTEGER DEFAULT 0, force_emergency_bypass_used INTEGER DEFAULT 0, emergency_drain_active INTEGER NOT NULL DEFAULT 0, upgrade_reminded_at INTEGER, upgrade_reminder_last_sent_at INTEGER, upgrade_reminder_count INTEGER DEFAULT 0, pi_stable_id_scheme INTEGER, session_facts_version INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS recomp_compartments (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, start_message INTEGER NOT NULL, end_message INTEGER NOT NULL, start_message_id TEXT DEFAULT '', end_message_id TEXT DEFAULT '', title TEXT NOT NULL, content TEXT NOT NULL, p1 TEXT, p2 TEXT, p3 TEXT, p4 TEXT, importance INTEGER NOT NULL DEFAULT 50, episode_type TEXT, pass_number INTEGER NOT NULL, created_at INTEGER NOT NULL, harness TEXT NOT NULL DEFAULT 'opencode', UNIQUE(session_id, sequence));
        CREATE TABLE IF NOT EXISTS embedding_identity_active (project_path TEXT NOT NULL, scope TEXT NOT NULL, model_id TEXT NOT NULL, last_active_at INTEGER NOT NULL, PRIMARY KEY(project_path, scope, model_id));
        CREATE TABLE IF NOT EXISTS git_sweep_coordinator (project_path TEXT PRIMARY KEY, lease_holder TEXT, lease_expires_at INTEGER, last_swept_at INTEGER);
        CREATE TABLE IF NOT EXISTS embedding_registrations (project_path TEXT PRIMARY KEY, source_directory TEXT NOT NULL DEFAULT '', provider_identity TEXT NOT NULL, model_id TEXT NOT NULL, chunk_model_id TEXT NOT NULL, runtime_fingerprint TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', table_epoch INTEGER NOT NULL DEFAULT 0, dims INTEGER NOT NULL DEFAULT 0, provenance_json TEXT NOT NULL DEFAULT '{}', generation INTEGER NOT NULL, features_json TEXT NOT NULL DEFAULT '{}', config_json TEXT NOT NULL DEFAULT '{}', observation_mode INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
        DROP TABLE IF EXISTS authority_managed;
        DROP TABLE IF EXISTS authority_repair_pending;
        DROP TABLE IF EXISTS context_privilege_state;
        DROP TABLE IF EXISTS context_store_meta;
        DROP TABLE IF EXISTS schema_migrations_meta;
        DROP TABLE IF EXISTS schema_migrations;
        DROP TABLE IF EXISTS synapse_batch_ledger;
        DROP TABLE IF EXISTS plugin_messages;
    `);
}
