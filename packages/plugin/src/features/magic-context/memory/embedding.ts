import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import { normalizeCompartmentChunkMaxInputTokens } from "../compartment-chunk-embedding";
import { cosineSimilarity } from "./cosine-similarity";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import { LocalEmbeddingProvider } from "./embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";
import type { EmbeddingProvider } from "./embedding-provider";

export type {
    EmbeddingFeatures,
    ProjectEmbeddingRegistrationSnapshot,
} from "../project-embedding-registry";
export {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    contentSha256,
    embedBatchForProject,
    embedItemsForProject,
    embedTextForProject,
    getProjectEmbeddingSnapshot,
    markProjectLoadUntrusted,
    registerProjectEmbedding,
    registerProjectInObservationMode,
} from "../project-embedding-registry";

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
    provider: "local",
    model: DEFAULT_LOCAL_EMBEDDING_MODEL,
};

let embeddingConfig: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG;
let provider: EmbeddingProvider | null = null;

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            ...(config?.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        const inputType = config.input_type?.trim();
        const queryInputType = config.query_input_type?.trim();
        const truncate = config.truncate?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(config.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }
    throw new Error("Unsupported embedding provider");
}

function resolveProviderIdentity(config: EmbeddingConfig): string {
    return getEmbeddingProviderIdentity(config);
}

function createProvider(config: EmbeddingConfig): EmbeddingProvider | null {
    if (config.provider === "openai-compatible") {
        return new OpenAICompatibleEmbeddingProvider({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.api_key,
            inputType: config.input_type,
            queryInputType: config.query_input_type,
            truncate: config.truncate,
            maxInputTokens: config.max_input_tokens,
        });
    }

    if (config.provider === "local") {
        return new LocalEmbeddingProvider(config.model, config.max_input_tokens);
    }
    throw new Error("Unsupported embedding provider");
}

function getOrCreateProvider(): EmbeddingProvider | null {
    if (provider) {
        return provider;
    }

    provider = createProvider(embeddingConfig);
    return provider;
}

export function initializeEmbedding(config: EmbeddingConfig): void {
    const nextConfig = resolveEmbeddingConfig(config);
    const nextProviderIdentity = resolveProviderIdentity(nextConfig);
    const previousProvider = provider;
    const previousProviderIdentity =
        previousProvider?.modelId ?? resolveProviderIdentity(embeddingConfig);

    if (previousProviderIdentity === nextProviderIdentity) {
        embeddingConfig = nextConfig;
        return;
    }

    embeddingConfig = nextConfig;
    provider = null;

    if (previousProvider) {
        void previousProvider.dispose().catch((error) => {
            log("[magic-context] embedding provider dispose failed:", error);
        });
    }
}

export function isEmbeddingEnabled(): boolean {
    return true;
}

export async function ensureEmbeddingModel(): Promise<boolean> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return false;
    }

    return currentProvider.initialize();
}

export async function embedText(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return null;
    }

    if (!(await currentProvider.initialize())) {
        return null;
    }

    return currentProvider.embed(text, signal);
}

export function getEmbeddingModelId(): string {
    return getOrCreateProvider()?.modelId ?? "unavailable";
}

export { cosineSimilarity };
