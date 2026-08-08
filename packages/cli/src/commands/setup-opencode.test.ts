import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "comment-json";
import {
    addPluginToOpenCodeConfig,
    findDcpPluginIndexes,
    writeMagicContextConfig,
} from "./setup-opencode";

const tempDirs: string[] = [];

function tempDir(): string {
    const path = mkdtempSync(join(tmpdir(), "mc-opencode-setup-"));
    tempDirs.push(path);
    return path;
}

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("setup-opencode config safety", () => {
    it("leaves malformed existing config unchanged", () => {
        const path = join(tempDir(), "magic-context.jsonc");
        const malformed = `{\n  "historian": {\n`;
        writeFileSync(path, malformed);

        expect(() =>
            writeMagicContextConfig(path, {
                historianModel: "anthropic/claude-sonnet-4-6",
                claudeMax: false,
            }),
        ).toThrow(`Refusing to overwrite unparseable config ${path}`);
        expect(readFileSync(path, "utf-8")).toBe(malformed);
    });

    it("re-detects targets created after discovery and merges them", () => {
        const root = tempDir();
        const opencodePath = join(root, "opencode.jsonc");
        writeFileSync(opencodePath, `{"theme":"dark","plugin":["other"]}`);

        // "none" is the stale pre-prompt detection result.
        addPluginToOpenCodeConfig(opencodePath, "none");

        expect(parseJsonc(readFileSync(opencodePath, "utf-8"))).toMatchObject({
            theme: "dark",
            plugin: ["other", "@ufoq/opencode-mini-magic-context@latest"],
        });
    });

    it("creates a missing config and merges a valid config", () => {
        const root = tempDir();
        const missingPath = join(root, "opencode.json");
        addPluginToOpenCodeConfig(missingPath, "none");
        expect(parseJsonc(readFileSync(missingPath, "utf-8"))).toMatchObject({
            compaction: { auto: false, prune: false },
        });

        const validPath = join(root, "existing.jsonc");
        writeFileSync(
            validPath,
            `{"theme":"dark","plugin":["other","@tarquinen/opencode-dcp@latest"]}`,
        );
        addPluginToOpenCodeConfig(validPath, "jsonc", true);
        const merged = parseJsonc(readFileSync(validPath, "utf-8")) as {
            theme?: string;
            plugin?: string[];
            compaction?: { auto?: boolean; prune?: boolean };
        };
        expect(merged).toMatchObject({
            theme: "dark",
            compaction: { auto: false, prune: false },
        });
        expect(merged.plugin).toContain("other");
        expect(merged.plugin).not.toContain("@tarquinen/opencode-dcp@latest");
    });

    it("writes the Mini Magic Context schema URL", () => {
        const path = join(tempDir(), "mini-magic-context.jsonc");

        writeMagicContextConfig(path, {
            historianModel: null,
            claudeMax: false,
        });

        expect(parseJsonc(readFileSync(path, "utf-8"))).toMatchObject({
            $schema:
                "https://raw.githubusercontent.com/ufoq/mini-magic-context/main/assets/magic-context.schema.json",
        });
    });

    it("writes only retained Magic Context settings", () => {
        const path = join(tempDir(), "mini-magic-context.jsonc");

        writeMagicContextConfig(path, {
            historianModel: "anthropic/claude-sonnet-4-6",
            claudeMax: false,
        });

        const config = parseJsonc(readFileSync(path, "utf-8"));
        expect(config).toMatchObject({ historian: { model: "anthropic/claude-sonnet-4-6" } });
        expect(config).not.toHaveProperty("dreamer");
        expect(config).not.toHaveProperty("sidekick");
    });
});

describe("setup-opencode DCP preflight", () => {
    it("is tuple-safe and only matches canonical opencode-dcp entries", () => {
        const plugins: unknown[] = [
            ["@plannotator/opencode@latest", { workflow: "plan-agent" }],
            "@some-fork/opencode-dcp-fork",
            ["@tarquinen/opencode-dcp@latest", { enabled: true }],
            "file:///tmp/opencode-dcp-dev",
        ];

        expect(() => findDcpPluginIndexes(plugins)).not.toThrow();
        expect(findDcpPluginIndexes(plugins)).toEqual([2]);
    });
});
