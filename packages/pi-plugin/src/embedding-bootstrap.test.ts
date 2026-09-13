import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cortexKitProjectConfigBasePath,
	cortexKitUserConfigBasePath,
} from "@magic-context/core/config/paths";
import {
	_resetProjectEmbeddingRegistryForTests,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	ensureProjectRegisteredFromPiDirectory,
	miniEmbeddingConfig,
} from "./embedding-bootstrap";
import { createTestDb } from "./test-utils.test";

describe("ensureProjectRegisteredFromPiDirectory", () => {
	it("preserves the embedding registration across consecutive identical registrations", async () => {
		const db = createTestDb();
		const oldHome = process.env.HOME;
		const directory = mkdtempSync(join(tmpdir(), "pi-embedding-bootstrap-"));
		const fakeHome = mkdtempSync(join(tmpdir(), "pi-embedding-home-"));
		process.env.HOME = fakeHome;
		try {
			const projectIdentity = resolveProjectIdentity(directory);

			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const first = getProjectEmbeddingSnapshot(projectIdentity);

			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const second = getProjectEmbeddingSnapshot(projectIdentity);

			expect(second?.runtimeFingerprint).toBe(first?.runtimeFingerprint);
			expect(second?.generation).toBe(first?.generation);
		} finally {
			_resetProjectEmbeddingRegistryForTests();
			if (oldHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = oldHome;
			}
			closeQuietly(db);
		}
	});

	it("ignores stale subc shadow memory and git embedding lanes", async () => {
		const db = createTestDb();
		const oldHome = process.env.HOME;
		const directory = mkdtempSync(join(tmpdir(), "pi-mini-stale-embedding-"));
		const fakeHome = mkdtempSync(
			join(tmpdir(), "pi-mini-stale-embedding-home-"),
		);
		process.env.HOME = fakeHome;
		try {
			const configBase = cortexKitProjectConfigBasePath(directory);
			mkdirSync(join(configBase, ".."), { recursive: true });
			writeFileSync(
				`${configBase}.jsonc`,
				JSON.stringify({
					embedding: {
						provider: "synapse",
						model: "stale",
						fallback_provider: "off",
					},
					subc: { connection_file: "/tmp/stale-subc.json" },
					shadow_embedding: { enabled: true },
					memory: { enabled: true, git_commit_indexing: { enabled: true } },
				}),
			);
			const projectIdentity = resolveProjectIdentity(directory);

			await ensureProjectRegisteredFromPiDirectory(directory, db);

			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			expect(snapshot?.provider).not.toBe("synapse");
			expect(snapshot?.features).toEqual({
				memoryEnabled: false,
				gitCommitEnabled: false,
			});
			expect(snapshot?.gitCommitEnabled).toBe(false);
		} finally {
			_resetProjectEmbeddingRegistryForTests();
			if (oldHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = oldHome;
			}
			closeQuietly(db);
		}
	});

	it("registers provider 'off' as a disabled no-op snapshot", async () => {
		const db = createTestDb();
		const oldHome = process.env.HOME;
		const directory = mkdtempSync(join(tmpdir(), "pi-embedding-off-"));
		const fakeHome = mkdtempSync(join(tmpdir(), "pi-embedding-off-home-"));
		process.env.HOME = fakeHome;
		try {
			const userConfigBase = cortexKitUserConfigBasePath();
			mkdirSync(join(userConfigBase, ".."), { recursive: true });
			writeFileSync(
				`${userConfigBase}.jsonc`,
				JSON.stringify({ embedding: { provider: "off" } }),
			);
			const projectIdentity = resolveProjectIdentity(directory);

			await ensureProjectRegisteredFromPiDirectory(directory, db);

			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			expect(snapshot?.enabled).toBe(false);
			expect(snapshot?.modelId).toBe("off");
			expect(snapshot?.chunkModelId).toBe("off");
			expect(snapshot?.provider).toBe("off");
			expect(snapshot?.runtimeFingerprint).not.toStartWith("observation:");
		} finally {
			_resetProjectEmbeddingRegistryForTests();
			if (oldHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = oldHome;
			}
			closeQuietly(db);
		}
	});

	it("preserves OpenAI-compatible fields", async () => {
		expect(
			miniEmbeddingConfig({
				provider: "openai-compatible",
				model: "qwen3",
				endpoint: "https://embeddings.example/v1",
				api_key: "secret-key",
				input_type: "document",
				query_input_type: "query",
				truncate: "END",
				max_input_tokens: 2048,
			}),
		).toEqual({
			provider: "openai-compatible",
			model: "qwen3",
			endpoint: "https://embeddings.example/v1",
			api_key: "secret-key",
			input_type: "document",
			query_input_type: "query",
			truncate: "END",
			max_input_tokens: 2048,
		});
	});
});
