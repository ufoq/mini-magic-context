import { z } from "zod";
import { isValidLanguageCode } from "../../agents/language-directive";
import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import { AgentOverrideConfigSchema } from "./agent-overrides";

export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
// Explains WHY execute_threshold is hard-capped at 80% (not just "too big").
// A single agent step can be large enough to overflow the context window before
// Magic Context can compact between turns; staying at/below 80% leaves headroom
// to absorb that and compact safely instead of falling back to the host's native
// compaction (far harder to recover from). 80% also sits below the 85% emergency
// and 95% block-and-recover bands, which are tuned around it.
export const EXECUTE_THRESHOLD_CAP_MESSAGE =
    "execute_threshold is capped at 80% for cache safety: a single large agent step can overflow the context window before Magic Context can compact between turns, forcing native host compaction (hard to recover from). 80% also leaves headroom below the 85%/95% emergency bands. Use a value between 20 and 80.";
export const DEFAULT_HISTORIAN_TIMEOUT_MS = 300_000;
export const DEFAULT_HISTORY_BUDGET_PERCENTAGE = 0.15;

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Valid thinking levels for Pi subagents. Maps to Pi's --thinking CLI flag.
 *  Off: disable reasoning. Minimal/low/medium/high/xhigh/max: increasing reasoning depth.
 *  `max` was added in Pi 0.83.0. */
export const PiThinkingLevelSchema = z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional();
export type PiThinkingLevel = z.infer<typeof PiThinkingLevelSchema>;

/** Pi-only child-process controls. This block is intentionally optional so an
 * absent allowlist preserves Pi's normal extension discovery behavior. */
export const PiConfigSchema = z
    .object({
        subagent_extensions: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
                "User-only allowlist of Pi extensions for Magic Context subagent children. When set, children use --no-extensions and load only these entries (plus Magic Context's scoped child extension where applicable). Relative paths resolve from ~/.pi/agent, matching Pi's settings.json package location. Unset preserves normal Pi extension discovery.",
            ),
    })
    .optional();
export type PiConfig = NonNullable<z.infer<typeof PiConfigSchema>>;

/** Historian agent configuration — includes all agent overrides plus two_pass mode.
 *  Two-pass mode runs a second editor pass after the initial historian pass to clean
 *  up low-signal U: lines and cross-compartment duplicates. Recommended for models
 *  without extended thinking; generally unnecessary for models with strong
 *  built-in reasoning. */
export const HistorianConfigSchema = AgentOverrideConfigSchema.extend({
    two_pass: z
        .boolean()
        .default(false)
        .describe(
            "Run a second editor pass over historian output to clean low-signal U: lines and cross-compartment duplicates. Adds ~1 extra API call and ~1.3x cost per historian run. Useful for models without extended thinking support. (default: false)",
        ),
    thinking_level: PiThinkingLevelSchema.describe(
        "Explicit thinking level passed as --thinking <level> to Pi historian subagent invocations. Required when using reasoning models (e.g. github-copilot/gpt-5.4) because Pi's default thinking-level resolution can pick a value the provider rejects. Valid: off | minimal | low | medium | high | xhigh | max",
    ),
}).optional();
export type HistorianConfig = NonNullable<z.infer<typeof HistorianConfigSchema>>;

const BaseEmbeddingConfigSchema = z
    .object({
        provider: z
            .enum(["local", "openai-compatible", "off"])
            .default("local")
            .describe(
                "Embedding provider. 'local' uses Xenova/all-MiniLM-L6-v2; 'openai-compatible' requires endpoint and model; 'off' disables semantic journal search.",
            ),
        model: z
            .string()
            .optional()
            .describe("Embedding model name. Required for openai-compatible, ignored for local."),
        endpoint: z
            .string()
            .optional()
            .describe("API endpoint URL. Required when provider is openai-compatible."),
        api_key: z.string().optional().describe("API key for remote embedding provider (optional)"),
        input_type: z
            .string()
            .optional()
            .describe(
                "Default input_type for stored/indexed (passage) embeddings in the request body. Required by some openai-compatible providers (e.g. NVIDIA NIM). Omitted from the request when unset.",
            ),
        query_input_type: z
            .string()
            .optional()
            .describe(
                "Optional input_type for query (search) embeddings on asymmetric models (e.g. NVIDIA NIM 'query'). When unset, query embeddings use embedding.input_type. Passage/stored content always uses embedding.input_type.",
            ),
        truncate: z
            .string()
            .optional()
            .describe(
                "Optional truncate mode sent in the embedding request body (e.g. NVIDIA NIM accepts 'NONE' | 'START' | 'END'). Omitted from the request when unset.",
            ),
        max_input_tokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
                "Optional maximum input tokens for chunk embeddings. Defaults conservatively to 512 when omitted.",
            ),
    })
    .superRefine((data, ctx) => {
        if (data.provider === "openai-compatible" && !data.endpoint?.trim()) {
            ctx.addIssue({
                code: "custom",
                path: ["endpoint"],
                message: "endpoint is required when embedding.provider is openai-compatible",
            });
        }

        if (data.provider === "openai-compatible" && !data.model?.trim()) {
            ctx.addIssue({
                code: "custom",
                path: ["model"],
                message: "model is required when embedding.provider is openai-compatible",
            });
        }
    });

export const EmbeddingConfigSchema = BaseEmbeddingConfigSchema.transform((data) => {
    if (data.provider === "local") {
        return {
            provider: "local" as const,
            model: data.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            ...(data.max_input_tokens ? { max_input_tokens: data.max_input_tokens } : {}),
        };
    }

    if (data.provider === "off") {
        return { provider: "off" as const };
    }

    const apiKey = data.api_key?.trim();
    const inputType = data.input_type?.trim();
    const queryInputType = data.query_input_type?.trim();
    const truncate = data.truncate?.trim();
    return {
        provider: "openai-compatible" as const,
        model: data.model?.trim() ?? "",
        endpoint: data.endpoint?.trim() ?? "",
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(inputType ? { input_type: inputType } : {}),
        ...(queryInputType ? { query_input_type: queryInputType } : {}),
        ...(truncate ? { truncate } : {}),
        ...(data.max_input_tokens ? { max_input_tokens: data.max_input_tokens } : {}),
    };
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export interface MagicContextConfig {
    enabled: boolean;
    /** Auto-update the installed Mini Magic Context package when a newer npm version is available.
     *  USER config only; project configs cannot disable it. Default: true. */
    auto_update?: boolean;
    /** Output language for generated Magic Context prose. USER config only. */
    language?: string;
    historian?: HistorianConfig;
    cache_ttl: string | { default: string; [modelKey: string]: string };
    /** TUI toast lifetime in milliseconds for Magic Context notifications. Default: 5000. */
    toast_duration_ms?: number;
    execute_threshold_percentage: number | { default: number; [modelKey: string]: number };
    /** Absolute token thresholds per model. When set for a given model (or via `default`),
     *  this overrides `execute_threshold_percentage` for that model. Useful for hard caps
     *  matching provider input limits. Values above 80% × context_limit are clamped with a warning. */
    execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
    protected_tags: number;
    clear_reasoning_age: number;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
    };
    /** Per-connection SQLite tuning for Magic Context's own context.db. */
    sqlite: {
        cache_size_mb: number;
        mmap_size_mb: number;
    };
    /**
     * Controls whether and where Magic Context augments the system prompt
     * (`## Magic Context` guidance and the sticky date).
     *
     * Magic Context's own historian child runs are always skipped automatically
     * — they use a separate code path.
     */
    system_prompt_injection: {
        /** When false, NO injection happens for ANY agent — global escape hatch. */
        enabled: boolean;
        /**
         * If the agent's system prompt contains any of these substrings,
         * skip ALL Magic Context injection for that call. Lets users opt
         * specific agents out (e.g. read-only QA agents that deny our
         * `ctx_*` tools and don't need the guidance). The default marker
         * `<!-- magic-context: skip -->` is meant to be added inside the
         * user's custom agent prompt.
         */
        skip_signatures: string[];
    };
    /** Inject elapsed-time markers between user messages and date ranges on
     *  compartments so the agent has a wall-clock sense of the session.
     *  Default: true. */
    temporal_awareness: boolean;
    keep_subagents: boolean;
    /**
     * When true (default), deterministic inoperability (schema fence, storage
     * open/migration failure) blocks the primary-session transform with a loud
     * recovery error instead of silently falling through to native compaction.
     * USER config only — project tier cannot set this. Not recommended to disable.
     */
    fail_closed_blocking: boolean;
    /** Pi-only child-process extension controls. */
    pi?: PiConfig;
    /** Content-aware reclaim of tool output that a later call supersedes, added
     *  to the normal age-based auto-drop: superseded meta outputs are dropped, and older edits to a file are compressed to a marker
     *  that keeps only the filePath. Only runs on a transform pass that is
     *  already rewriting the messages, so it never triggers a prompt-cache miss
     *  on its own; when off, the messages sent to the model are byte-identical to
     *  the age-based-only behavior. Experimental, opt-in, default off until cache
     *  stability is proven. */
    smart_drops: boolean;
    /**
     * Age-tier caveman compression for long user/assistant text parts.
     * Opt-in, default off.
     *
     * Active only for primary sessions when enabled; never for subagents.
     * Buckets eligible (outside-protected-tail) messages into four age
     * tiers by tag position — oldest 20% → ultra, next 20% → full,
     * next 20% → lite, newest 40% → untouched — and rewrites the text
     * part in place.
     * Always compresses from the original source (source_contents), so
     * tier shifts produce the same result as if the target depth were
     * applied directly to the original text.
     *
     * Disabled by default because it rewrites agent-visible history.
     */
    caveman_text_compression: {
        enabled: boolean;
        /** Text parts shorter than this (characters) are left untouched. */
        min_chars: number;
    };
    embedding: EmbeddingConfig;
    journal: {
        auto_search: {
            enabled: boolean;
            score_threshold: number;
            min_prompt_chars: number;
        };
    };
}

export const MagicContextConfigSchema = z
    .object({
        enabled: z.boolean().default(true).describe("Enable magic context (default: true)"),
        auto_update: z
            .boolean()
            .optional()
            .describe(
                "Enable automatic npm self-update checks for Mini Magic Context. Security: USER-only in config loader, so hostile project configs cannot suppress updates.",
            ),
        language: z
            .string()
            .trim()
            .toLowerCase()
            .refine(
                (s) => isValidLanguageCode(s),
                'language must be a 2-letter ISO 639-1 code (e.g. "tr", "es", "de")',
            )
            .optional()
            .describe(
                "Output language for Magic Context's generated content and guidance, as a " +
                    '2-letter ISO 639-1 code (e.g. "tr", "es", "de", "ja", "pt"). When set, the ' +
                    "historian and the agent-guidance block instruct the model to " +
                    "write its PROSE in this language while keeping all structural tokens (XML tags, " +
                    "code identifiers, file paths) in English. " +
                    "USER-LEVEL ONLY (ignored in project config for security). Unset = today's " +
                    "behavior (model mirrors the conversation; English scaffolding). Changing it " +
                    "triggers one cache re-materialization; existing compartments keep their " +
                    "original language until naturally rewritten.",
            ),
        historian: HistorianConfigSchema.describe(
            "Historian agent configuration (model, fallback_models, temperature, maxTokens, two_pass, and thinking_level).",
        ),
        cache_ttl: z
            .union([z.string(), z.object({ default: z.string() }).catchall(z.string())])
            .default("5m")
            .describe(
                'Cache TTL: string (e.g. "5m") or per-model object ({ default: "5m", "model-id": "10m" })',
            ),
        toast_duration_ms: z
            .number()
            .min(0)
            .max(60_000)
            .default(5_000)
            .describe(
                "TUI toast lifetime in milliseconds for Magic Context notifications. Set to 0 to disable Magic Context toasts entirely (min: 0, max: 60000, default: 5000)",
            ),
        execute_threshold_percentage: z
            .union([
                z.number().min(20).max(80, EXECUTE_THRESHOLD_CAP_MESSAGE),
                z
                    .object({ default: z.number().min(20).max(80, EXECUTE_THRESHOLD_CAP_MESSAGE) })
                    .catchall(z.number().min(20).max(80, EXECUTE_THRESHOLD_CAP_MESSAGE)),
            ])
            .default(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE)
            .describe(
                'Context percentage that forces queued operations to execute. Number or per-model object ({ default: 65, "provider/model": 45 }). Values above 80 are rejected because the runtime caps at 80% for cache safety (MAX_EXECUTE_THRESHOLD). Default: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE',
            ),
        execute_threshold_tokens: z
            .object({
                default: z.number().min(5_000).max(2_000_000).optional(),
            })
            .catchall(z.number().min(5_000).max(2_000_000))
            .optional()
            .describe(
                "Absolute token thresholds per model. When matched, overrides execute_threshold_percentage for that model. Accepts `default` for all models or per-model keys. Values above 80% × context_limit are clamped with a warning log. Min 5_000, max 2_000_000.",
            ),
        protected_tags: z
            .number()
            .min(1)
            .max(100)
            .optional()
            .describe(
                "Number of recent tags to protect from dropping (min: 1, max: 100, default: 20)",
            ),
        clear_reasoning_age: z
            .number()
            .min(10)
            .default(50)
            .describe("Clear reasoning/thinking blocks older than N tags (default: 50)"),
        history_budget_percentage: z
            .number()
            .min(0.05)
            .max(0.5)
            .default(DEFAULT_HISTORY_BUDGET_PERCENTAGE)
            .describe(
                "Fraction of usable context (context_limit × execute_threshold) reserved for the session history block (default: 0.15)",
            ),
        historian_timeout_ms: z
            .number()
            .min(60_000)
            .default(DEFAULT_HISTORIAN_TIMEOUT_MS)
            .describe("Timeout for each historian prompt call in milliseconds (default: 300000)"),
        commit_cluster_trigger: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe("Enable commit-cluster based historian triggering (default: true)"),
                min_clusters: z
                    .number()
                    .min(1)
                    .default(3)
                    .describe(
                        "Minimum commit clusters required to trigger historian (min: 1, default: 3)",
                    ),
            })
            .default({ enabled: true, min_clusters: 3 })
            .describe(
                "Commit-cluster trigger: fire historian when enough commit clusters accumulate in the unsummarized tail",
            ),
        system_prompt_injection: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe(
                        "When false, NO injection happens for ANY agent — global escape hatch. (default: true)",
                    ),
                skip_signatures: z
                    .array(z.string())
                    .default(["<!-- magic-context: skip -->"])
                    .describe(
                        "Substring opt-out list. If the agent's system prompt contains any of these strings, skip ALL Magic Context injection for that call. Default \"<!-- magic-context: skip -->\" is meant to be added inside a user's custom agent prompt to opt that agent out.",
                    ),
            })
            .default({
                enabled: true,
                skip_signatures: ["<!-- magic-context: skip -->"],
            })
            .describe(
                "Controls whether and where Magic Context augments the system prompt. Lets users opt specific agents out of the Magic Context guidance. Magic Context's own historian child runs are always skipped automatically.",
            ),
        // v2: the LLM compressor was removed — deterministic decay-tier rendering
        // (decay-render.ts) replaces it, so there are no compressor knobs. A
        // leftover `compressor` block in an existing config is silently ignored
        // (the schema strips unknown keys).
        sqlite: z
            .object({
                cache_size_mb: z
                    .number()
                    .min(2)
                    .max(2048)
                    .default(64)
                    .describe(
                        "Page-cache size in MiB per connection (PRAGMA cache_size). Larger keeps more hot pages resident, cutting re-reads on repeated full-table scans. (min 2, max 2048, default 64)",
                    ),
                mmap_size_mb: z
                    .number()
                    .min(0)
                    .max(8192)
                    .default(0)
                    .describe(
                        "Memory-mapped I/O size in MiB (PRAGMA mmap_size). 0 disables mmap (SQLite default). Raising it can cut read overhead on large DBs at the cost of address space. (min 0, max 8192, default 0)",
                    ),
            })
            .default({ cache_size_mb: 64, mmap_size_mb: 0 })
            .describe(
                "SQLite connection tuning for Magic Context's own context.db. These are per-connection PRAGMAs applied at open; they do not change the schema or what is stored.",
            ),
        embedding: EmbeddingConfigSchema.default({
            provider: "local",
            model: DEFAULT_LOCAL_EMBEDDING_MODEL,
        }).describe("Embedding provider configuration"),
        temporal_awareness: z
            .boolean()
            .default(true)
            .describe(
                "Inject wall-clock gap markers (<!-- +Xm -->) between user messages where > 5 min elapsed since the previous message, and add compact date ranges to compartment headings. Default: true (set false to opt out).",
            ),
        keep_subagents: z
            .boolean()
            .default(false)
            .describe(
                "Debug: keep the child sessions Magic Context spawns for its historian instead of deleting them on success.",
            ),
        fail_closed_blocking: z
            .boolean()
            .default(true)
            .describe(
                "When Magic Context cannot operate (schema fence mismatch, storage open/migration failure), block the primary-session prompt with a loud recovery error instead of silently degrading to native compaction. Default true. Set false only to restore the old degrade-silently behavior (not recommended). USER-LEVEL ONLY — ignored in project config for security. Requires a restart.",
            ),
        pi: PiConfigSchema.describe(
            "Pi-only child-process extension controls. This setting is user-level only; project configuration cannot choose which extensions a user's subagent children load.",
        ),
        smart_drops: z
            .boolean()
            .default(false)
            .describe(
                "Content-aware reclaim of provably-superseded tool output, layered on the existing execute-pass auto-drop. When on: zero-value meta (bash_status, bash_kill) outputs are dropped; older edits to a file are compressed to a filePath-preserving marker while the newest edit per file stays full. Only acts on passes already busting the cache, so it never originates a cache bust. Honors the protected-tag reserve. Experimental: opt-in, default off until cache stability is proven; when off the wire is byte-identical to the positional-only reclaim. Requires a restart.",
            ),
        caveman_text_compression: z
            .object({
                enabled: z
                    .boolean()
                    .default(false)
                    .describe(
                        "Apply deterministic caveman-style text compression to old conversation text. Active for primary sessions when enabled; never for subagents. Compresses user/assistant text in oldest-first tiers: ultra (oldest 20%), full, lite, untouched (newest 40%).",
                    ),
                min_chars: z
                    .number()
                    .min(100)
                    .max(10000)
                    .default(500)
                    .describe(
                        "Text parts shorter than this (characters) stay untouched. Min 100, max 10000. Default: 500.",
                    ),
            })
            .default({ enabled: false, min_chars: 500 })
            .describe(
                "Age-tier caveman compression for long user/assistant text parts. Active for primary sessions when enabled; never for subagents. Oldest 20% of eligible tags (outside protected tail) go to ultra, next 20% to full, next 20% to lite, newest 40% untouched. Opt-in, default off (lossy).",
            ),
        journal: z
            .object({
                auto_search: z
                    .object({
                        enabled: z
                            .boolean()
                            .default(true)
                            .describe(
                                "Automatically append a compact <ctx-search-hint> to eligible user messages when relevant journal entries are found.",
                            ),
                        score_threshold: z
                            .number()
                            .min(0.3)
                            .max(0.95)
                            .default(0.6)
                            .describe(
                                "Top hit score must exceed this threshold for the hint to fire (min: 0.3, max: 0.95, default: 0.60)",
                            ),
                        min_prompt_chars: z
                            .number()
                            .min(5)
                            .max(500)
                            .default(20)
                            .describe(
                                "Skip hint when user message is shorter than this (min: 5, max: 500, default: 20)",
                            ),
                    })
                    .default({ enabled: true, score_threshold: 0.6, min_prompt_chars: 20 })
                    .describe(
                        "Auto-search hint: transform-time journal search on each new user message; when the top hit clears the threshold, append compact fragments to that user message.",
                    ),
            })
            .default({ auto_search: { enabled: true, score_threshold: 0.6, min_prompt_chars: 20 } })
            .describe("Journal search configuration"),
    })
    .transform((data): MagicContextConfig => {
        return {
            ...data,
            protected_tags: data.protected_tags ?? DEFAULT_PROTECTED_TAGS,
        };
    });
