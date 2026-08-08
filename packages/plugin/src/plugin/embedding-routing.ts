import type { EmbeddingConfig, MagicContextConfig } from "../config/schema/magic-context";

export interface ResolvedEmbeddingRouting {
    readonly primary: EmbeddingConfig;
    readonly shadow: null;
    readonly warnings: readonly string[];
}

export async function resolveEmbeddingRouting(args: {
    readonly config: MagicContextConfig;
    readonly projectRoot: string;
    readonly session?: string;
}): Promise<ResolvedEmbeddingRouting> {
    void args.projectRoot;
    void args.session;
    return { primary: args.config.embedding, shadow: null, warnings: [] };
}
