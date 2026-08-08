import { loadPluginConfigDetailed } from "../config";
import type { EmbeddingConfig } from "../config/schema/magic-context";
import {
    type EmbeddingFeatures,
    registerProjectEmbedding,
} from "../features/magic-context/memory/embedding";
import { invalidateProject } from "../features/magic-context/memory/embedding-cache";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import type { Database } from "../shared/sqlite";
import { handleUntrustedLoad, isConfigLoadUntrusted } from "./embedding-bootstrap-helpers";

export function miniEmbeddingConfig(config: EmbeddingConfig): EmbeddingConfig {
    return config;
}

export async function ensureProjectRegisteredFromOpenCodeDirectory(
    directory: string,
    db: Database,
): Promise<void> {
    const projectIdentity = resolveProjectIdentityForSession(directory);
    if (!projectIdentity) return;
    invalidateProject(projectIdentity);

    const detailed = loadPluginConfigDetailed(directory);
    if (isConfigLoadUntrusted(detailed)) {
        handleUntrustedLoad(db, projectIdentity, directory, detailed);
        return;
    }

    const features: EmbeddingFeatures = {
        memoryEnabled: false,
        gitCommitEnabled: false,
    };
    registerProjectEmbedding(
        db,
        projectIdentity,
        miniEmbeddingConfig(detailed.config.embedding),
        features,
        directory,
    );
}
