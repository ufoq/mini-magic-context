import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { closeDatabase } from "../features/magic-context/storage";
import { createToolRegistry } from "./tool-registry";
import type { PluginContext } from "./types";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {}
    }
    tempDirs.length = 0;
});

function isolateDb(): void {
    const dir = mkdtempSync(join(tmpdir(), "tool-registry-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

const ctx = { directory: process.cwd() } as unknown as PluginContext;

function buildRegistry(config: Partial<MagicContextPluginConfig>) {
    return createToolRegistry({
        ctx,
        pluginConfig: { enabled: true, ...config } as MagicContextPluginConfig,
    });
}

describe("createToolRegistry", () => {
    it("advertises only retained ctx_search and ctx_expand fields", () => {
        isolateDb();
        const tools = buildRegistry({});
        const expectedFields: Record<string, string[]> = {
            ctx_expand: ["start", "end", "verbose", "message"],
            ctx_search: ["query", "limit", "sources"],
        };

        expect(Object.keys(tools).sort()).toEqual(Object.keys(expectedFields).sort());
        for (const [name, fields] of Object.entries(expectedFields)) {
            const definition = tools[name];
            expect(definition).toBeDefined();
            const jsonSchema = tool.schema.toJSONSchema(
                tool.schema.object(definition?.args ?? {}),
            ) as { properties?: Record<string, unknown> };
            expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual([...fields].sort());
            expect(jsonSchema.properties).not.toHaveProperty("reduced");
            expect(jsonSchema.properties).not.toHaveProperty("summary");
        }
    });

    it("keeps the same retained surface when memory or rust mode is configured", () => {
        isolateDb();
        const memoryOff = buildRegistry({ memory: { enabled: false } as never });
        const rustConfigured = buildRegistry({ transform_mode: "rust" });

        expect(Object.keys(memoryOff).sort()).toEqual(["ctx_expand", "ctx_search"]);
        expect(Object.keys(rustConfigured).sort()).toEqual(["ctx_expand", "ctx_search"]);
    });
});
