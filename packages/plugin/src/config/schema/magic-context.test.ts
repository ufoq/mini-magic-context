import { describe, expect, it } from "bun:test";
import {
    DEFAULT_HISTORIAN_TIMEOUT_MS,
    DEFAULT_HISTORY_BUDGET_PERCENTAGE,
    DEFAULT_LOCAL_EMBEDDING_MODEL,
    type MagicContextConfig,
    MagicContextConfigSchema,
} from "./magic-context";

describe("MagicContextConfigSchema", () => {
    describe("defaults", () => {
        it("applies defaults for an empty config", () => {
            const result = MagicContextConfigSchema.parse({});

            expect(result).toMatchObject({
                enabled: true,
                fail_closed_blocking: true,
                cache_ttl: "5m",
                execute_threshold_percentage: 65,
                protected_tags: 20,
                clear_reasoning_age: 50,
                history_budget_percentage: DEFAULT_HISTORY_BUDGET_PERCENTAGE,
                historian_timeout_ms: DEFAULT_HISTORIAN_TIMEOUT_MS,
                embedding: {
                    provider: "local",
                    model: DEFAULT_LOCAL_EMBEDDING_MODEL,
                },
                journal: {
                    auto_search: { enabled: true, score_threshold: 0.6, min_prompt_chars: 20 },
                },
            });
            expect(result.historian).toBeUndefined();
            expect(result.pi).toBeUndefined();
            expect(result).not.toHaveProperty("dreamer");
            expect(result).not.toHaveProperty("sidekick");
            expect(result).not.toHaveProperty("experimental");
            expect(result).not.toHaveProperty("subc");
            expect(result).not.toHaveProperty("shadow_embedding");
            expect(result).not.toHaveProperty("memory");
        });
    });

    describe("valid config", () => {
        it("parses an enabled config without stale reduction-specific keys", () => {
            const input = {
                enabled: true,
                fail_closed_blocking: true,
                auto_update: false,
                toast_duration_ms: 5000,
                cache_ttl: "10m",
                protected_tags: 3,
                execute_threshold_percentage: 75,
                clear_reasoning_age: 60,
                history_budget_percentage: 0.2,
                historian_timeout_ms: 360_000,
                commit_cluster_trigger: {
                    enabled: true,
                    min_clusters: 3,
                },
                sqlite: {
                    cache_size_mb: 64,
                    mmap_size_mb: 0,
                },
                system_prompt_injection: {
                    enabled: true,
                    skip_signatures: ["<!-- magic-context: skip -->"],
                },
                temporal_awareness: false,
                keep_subagents: false,
                todowrite: {
                    enabled: false,
                    overlay: false,
                },
                smart_drops: false,
                caveman_text_compression: {
                    enabled: false,
                    min_chars: 500,
                },
                embedding: {
                    provider: "openai-compatible",
                    endpoint: "http://localhost:1234/v1",
                    model: "text-embedding-3-small",
                    api_key: "secret-embedding",
                },
                journal: {
                    auto_search: {
                        enabled: false,
                        score_threshold: 0.6,
                        min_prompt_chars: 20,
                    },
                },
                pi: {
                    subagent_extensions: ["@example/provider", "./extensions/local.ts"],
                },
            } satisfies MagicContextConfig;

            const result = MagicContextConfigSchema.parse(input);

            expect(result).toEqual(input);
        });

        it("accepts disable on the historian and strips deprecated enabled", () => {
            const result = MagicContextConfigSchema.parse({
                historian: { disable: true },
            });

            expect(result.historian?.disable).toBe(true);
            expect("enabled" in (result.historian as Record<string, unknown>)).toBe(false);
        });

        it("strips the removed transform_mode from parsed output", () => {
            const result = MagicContextConfigSchema.parse({ transform_mode: "rust" });
            expect(result).not.toHaveProperty("transform_mode");
        });

        it("strips dropped feature configuration", () => {
            const result = MagicContextConfigSchema.parse({
                dreamer: { model: "anthropic/claude-haiku-4-5" },
                sidekick: { model: "anthropic/claude-haiku-4-5" },
                experimental: { mural: { enabled: true } },
                subc: { connection_file: "~/.subc.json" },
                shadow_embedding: { enabled: true },
                memory: {
                    enabled: true,
                    git_commit_indexing: { enabled: true },
                    auto_search: { enabled: false },
                },
            });

            expect(result).not.toHaveProperty("dreamer");
            expect(result).not.toHaveProperty("sidekick");
            expect(result).not.toHaveProperty("experimental");
            expect(result).not.toHaveProperty("subc");
            expect(result).not.toHaveProperty("shadow_embedding");
            expect(result).not.toHaveProperty("memory");
            expect(result.embedding).toEqual({
                provider: "local",
                model: DEFAULT_LOCAL_EMBEDDING_MODEL,
            });
            expect(() =>
                MagicContextConfigSchema.parse({
                    embedding: { provider: "synapse", fallback_provider: "local" },
                }),
            ).toThrow();
            expect(
                MagicContextConfigSchema.parse({ embedding: { provider: "off" } }).embedding,
            ).toEqual({
                provider: "off",
            });
        });

        it("accepts optional auto_update user preference", () => {
            expect(MagicContextConfigSchema.parse({ auto_update: false }).auto_update).toBe(false);
            expect(MagicContextConfigSchema.parse({ auto_update: true }).auto_update).toBe(true);
        });

        it("accepts an explicitly configured Pi subagent extension allowlist", () => {
            expect(
                MagicContextConfigSchema.parse({
                    pi: { subagent_extensions: ["provider-package", "./local.ts"] },
                }).pi,
            ).toEqual({ subagent_extensions: ["provider-package", "./local.ts"] });
        });

        it("accepts and normalizes 2-letter ISO 639-1 language codes", () => {
            expect(MagicContextConfigSchema.parse({ language: "tr" }).language).toBe("tr");
            expect(MagicContextConfigSchema.parse({ language: "  ES " }).language).toBe("es");
            expect(MagicContextConfigSchema.parse({ language: "ja" }).language).toBe("ja");
        });

        it("parses per-model cache_ttl objects", () => {
            const input = {
                cache_ttl: {
                    default: "5m",
                    "claude-3-haiku": "10m",
                    "gpt-4": "2m",
                },
            };

            const result = MagicContextConfigSchema.parse(input);

            expect(result.cache_ttl).toEqual(input.cache_ttl);
        });
    });

    describe("validation", () => {
        it("rejects empty Pi subagent extension entries", () => {
            expect(() =>
                MagicContextConfigSchema.parse({ pi: { subagent_extensions: ["  "] } }),
            ).toThrow();
        });

        it("rejects protected_tags greater than 100", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tags: 101 })).toThrow();
        });

        it("rejects protected_tags less than 1", () => {
            expect(() => MagicContextConfigSchema.parse({ protected_tags: 0 })).toThrow();
        });

        it("accepts protected_tags boundary values", () => {
            expect(MagicContextConfigSchema.parse({ protected_tags: 1 }).protected_tags).toBe(1);
            expect(MagicContextConfigSchema.parse({ protected_tags: 20 }).protected_tags).toBe(20);
        });

        it("rejects clear_reasoning_age below minimum", () => {
            expect(() => MagicContextConfigSchema.parse({ clear_reasoning_age: 9 })).toThrow();
        });

        it("rejects historian_timeout_ms below minimum", () => {
            expect(() =>
                MagicContextConfigSchema.parse({ historian_timeout_ms: 59_999 }),
            ).toThrow();
        });

        it("rejects non-code output language values", () => {
            expect(() => MagicContextConfigSchema.parse({ language: "Turkish" })).toThrow(); // full name
            expect(() => MagicContextConfigSchema.parse({ language: "tur" })).toThrow(); // 3-letter
            expect(() => MagicContextConfigSchema.parse({ language: "zz" })).toThrow(); // unknown code
            expect(() => MagicContextConfigSchema.parse({ language: "<x>" })).toThrow();
        });

        it("rejects openai-compatible embedding config without endpoint", () => {
            expect(() =>
                MagicContextConfigSchema.parse({
                    embedding: {
                        provider: "openai-compatible",
                        model: "text-embedding-3-small",
                    },
                }),
            ).toThrow();
        });

        it("rejects openai-compatible embedding config without model", () => {
            expect(() =>
                MagicContextConfigSchema.parse({
                    embedding: {
                        provider: "openai-compatible",
                        endpoint: "http://localhost:1234/v1",
                    },
                }),
            ).toThrow();
        });
    });
});
