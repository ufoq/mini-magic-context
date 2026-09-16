import { statSync } from "node:fs";
import {
	cortexKitProjectConfigBasePath,
	cortexKitUserConfigBasePath,
} from "@ufoq/mini-magic-context-core/config/paths";
import type { EmbeddingConfig } from "@ufoq/mini-magic-context-core/config/schema/magic-context";
import {
	type EmbeddingFeatures,
	registerProjectEmbedding,
} from "@ufoq/mini-magic-context-core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@ufoq/mini-magic-context-core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@ufoq/mini-magic-context-core/features/magic-context/storage";
import {
	handleUntrustedLoad,
	isConfigLoadUntrusted,
} from "@ufoq/mini-magic-context-core/plugin/embedding-bootstrap-helpers";
import { loadPiConfigDetailed } from "./config";

interface RegistrationFingerprint {
	paths: string[];
	fingerprint: string;
}

const registrationFingerprintsByDatabase = new WeakMap<
	object,
	Map<string, RegistrationFingerprint>
>();

function configCandidatePaths(
	directory: string,
	loadedPaths: readonly string[],
): string[] {
	const projectBase = cortexKitProjectConfigBasePath(directory);
	const userBase = cortexKitUserConfigBasePath();
	return [
		`${projectBase}.jsonc`,
		`${projectBase}.json`,
		`${userBase}.jsonc`,
		`${userBase}.json`,
		...loadedPaths,
	].filter((path, index, paths) => paths.indexOf(path) === index);
}

function configFingerprint(paths: readonly string[]): string {
	return paths
		.map((path) => {
			try {
				const stat = statSync(path);
				return `${path}:${stat.size}:${stat.mtimeMs}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("|");
}

export function miniEmbeddingConfig(config: EmbeddingConfig): EmbeddingConfig {
	return config;
}

export async function ensureProjectRegisteredFromPiDirectory(
	directory: string,
	db: ContextDatabase,
): Promise<void> {
	const projectIdentity = resolveProjectIdentityForSession(directory);
	if (!projectIdentity) return;
	let registrationFingerprints = registrationFingerprintsByDatabase.get(db);
	if (!registrationFingerprints) {
		registrationFingerprints = new Map();
		registrationFingerprintsByDatabase.set(db, registrationFingerprints);
	}
	const cached = registrationFingerprints.get(projectIdentity);
	if (cached && configFingerprint(cached.paths) === cached.fingerprint) return;

	const detailed = loadPiConfigDetailed({ cwd: directory });
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
	const fingerprintPaths = configCandidatePaths(
		directory,
		detailed.loadedFromPaths,
	);
	registrationFingerprints.set(projectIdentity, {
		paths: fingerprintPaths,
		fingerprint: configFingerprint(fingerprintPaths),
	});
}
