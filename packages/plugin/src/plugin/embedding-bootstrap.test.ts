import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cortexKitUserConfigBasePath } from "../config/migrate-config-location";
import {
    _resetProjectEmbeddingRegistryForTests,
    getProjectEmbeddingSnapshot,
} from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import {
    ensureProjectRegisteredFromOpenCodeDirectory,
    miniEmbeddingConfig,
} from "./embedding-bootstrap";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    _resetProjectEmbeddingRegistryForTests();
    closeDatabase();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

describe("ensureProjectRegisteredFromOpenCodeDirectory", () => {
    it("reads the legacy config and registers the real identity (not observation) when only legacy config exists", async () => {
        const projectDir = tempDir("mc-legacy-boot-");
        process.env.HOME = tempDir("mc-legacy-home-");
        process.env.XDG_CONFIG_HOME = tempDir("mc-legacy-config-");
        process.env.XDG_DATA_HOME = tempDir("mc-legacy-data-");
        // Read-legacy-on-conflict: the CortexKit base is absent but THIS harness's
        // legacy project config exists, so it is read and trusted — NOT treated as
        // an untrusted/observation load that would suppress registration. The real
        // embedding identity is registered so the project is fully functional
        // before the user consolidates.
        writeFileSync(
            join(projectDir, "magic-context.jsonc"),
            '{"embedding":{"provider":"openai-compatible","model":"qwen3","endpoint":"http://localhost:1234/v1"}}',
        );
        const db = openDatabase();
        const projectIdentity = resolveProjectIdentity(projectDir);

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
        expect(snapshot?.enabled).toBe(true);
        expect(snapshot?.runtimeFingerprint).not.toStartWith("observation:");
    });

    it("registers provider 'off' as a disabled no-op snapshot", async () => {
        const projectDir = tempDir("mc-off-boot-");
        process.env.HOME = tempDir("mc-off-home-");
        process.env.XDG_CONFIG_HOME = tempDir("mc-off-config-");
        process.env.XDG_DATA_HOME = tempDir("mc-off-data-");
        const userConfigBase = cortexKitUserConfigBasePath();
        mkdirSync(join(userConfigBase, ".."), { recursive: true });
        writeFileSync(`${userConfigBase}.jsonc`, '{"embedding":{"provider":"off"}}');
        const db = openDatabase();
        const projectIdentity = resolveProjectIdentity(projectDir);

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
        expect(snapshot?.enabled).toBe(false);
        expect(snapshot?.modelId).toBe("off");
        expect(snapshot?.chunkModelId).toBe("off");
        expect(snapshot?.provider).toBe("off");
        expect(snapshot?.runtimeFingerprint).not.toStartWith("observation:");
    });

    it("ignores stale subc shadow memory and git embedding lanes", async () => {
        const projectDir = tempDir("mc-mini-stale-embedding-boot-");
        process.env.HOME = tempDir("mc-mini-stale-embedding-home-");
        process.env.XDG_CONFIG_HOME = tempDir("mc-mini-stale-embedding-config-");
        process.env.XDG_DATA_HOME = tempDir("mc-mini-stale-embedding-data-");
        writeFileSync(
            join(projectDir, "magic-context.jsonc"),
            JSON.stringify({
                embedding: { provider: "synapse", model: "stale", fallback_provider: "off" },
                subc: { connection_file: "/tmp/stale-subc.json" },
                shadow_embedding: { enabled: true },
                memory: { enabled: true, git_commit_indexing: { enabled: true } },
            }),
        );
        const db = openDatabase();
        const projectIdentity = resolveProjectIdentity(projectDir);

        await ensureProjectRegisteredFromOpenCodeDirectory(projectDir, db);

        const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
        expect(snapshot?.provider).not.toBe("synapse");
        expect(snapshot?.features).toEqual({ memoryEnabled: false, gitCommitEnabled: false });
        expect(snapshot?.gitCommitEnabled).toBe(false);
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
