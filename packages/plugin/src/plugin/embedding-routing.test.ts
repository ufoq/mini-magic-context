import { describe, expect, it } from "bun:test";
import { MagicContextConfigSchema } from "../config/schema/magic-context";
import { resolveEmbeddingRouting } from "./embedding-routing";

describe("embedding routing", () => {
    it("uses the configured OpenAI-compatible provider without a shadow lane", async () => {
        const config = MagicContextConfigSchema.parse({
            embedding: {
                provider: "openai-compatible",
                model: "qwen3",
                endpoint: "https://embeddings.example/v1",
            },
        });

        const routing = await resolveEmbeddingRouting({ config, projectRoot: "/repo" });

        expect(routing.primary).toEqual(config.embedding);
        expect(routing.shadow).toBeNull();
        expect(routing.warnings).toEqual([]);
    });
});
