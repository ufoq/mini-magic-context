import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "@magic-context/core/shared/sqlite";
import { parse as parseJsonc } from "comment-json";
import { openExistingContextDatabase } from "../lib/database-access";
import type { PiDiagnosticReport } from "../lib/diagnostics-pi";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { type RunDoctorOptions, runDoctor } from "./doctor-pi";

setDefaultTimeout(30_000);

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalCacheHome = process.env.XDG_CACHE_HOME;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(prefix = "mc-pi-doctor-"): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    private readonly texts: string[];
    private readonly confirms: boolean[];

    constructor(options: { texts?: string[]; confirms?: boolean[] } = {}) {
        this.texts = [...(options.texts ?? [])];
        this.confirms = [...(options.confirms ?? [])];
    }

    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
    };

    intro(message: string): void {
        this.messages.push(`intro:${message}`);
    }

    outro(message: string): void {
        this.messages.push(`outro:${message}`);
    }

    note(message: string, title?: string): void {
        this.messages.push(`note:${title ?? ""}:${message}`);
    }

    spinner(): PromptSpinner {
        return {
            start: (message: string) => this.messages.push(`spinner-start:${message}`),
            stop: (message: string) => this.messages.push(`spinner-stop:${message}`),
        };
    }

    async confirm(): Promise<boolean> {
        return this.confirms.shift() ?? false;
    }

    async text(_message: string, options = {}): Promise<string> {
        return this.texts.shift() ?? options.initialValue ?? "mock text";
    }

    async selectOne(_message: string, options: SelectOption[]): Promise<string> {
        return options.find((option) => option.recommended)?.value ?? options[0].value;
    }
}

function setEnv(root: string, cwd: string): string {
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = join(root, ".pi", "agent");
    process.env.XDG_DATA_HOME = join(root, ".local", "share");
    process.env.XDG_CACHE_HOME = join(root, ".cache");
    process.env.XDG_CONFIG_HOME = join(root, ".config");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    mkdirSync(join(process.env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
    mkdirSync(join(cwd, ".cortexkit"), { recursive: true });
    return process.env.PI_CODING_AGENT_DIR;
}

function writeHealthyFiles(agentDir: string, cwd: string): void {
    writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({
            packages: ["npm:@ufoq/pi-mini-magic-context", "npm:other-pi-extension"],
        }),
    );
    const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
    writeFileSync(
        join(configHome, "cortexkit", "mini-magic-context.jsonc"),
        JSON.stringify({ embedding: { provider: "local" } }),
    );
    writeFileSync(
        join(cwd, ".cortexkit", "mini-magic-context.jsonc"),
        JSON.stringify({ enabled: true }),
    );
}

function createInstalledPiPlugin(agentDir: string, withNativeBinding: boolean): void {
    const pluginDir = join(agentDir, "npm", "node_modules", "@ufoq", "pi-mini-magic-context");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@ufoq/pi-mini-magic-context", version: "0.0.0" }),
    );

    const onnxDir = join(pluginDir, "node_modules", "onnxruntime-node");
    mkdirSync(onnxDir, { recursive: true });
    writeFileSync(
        join(onnxDir, "package.json"),
        JSON.stringify({ name: "onnxruntime-node", main: "index.js" }),
    );
    writeFileSync(join(onnxDir, "index.js"), "module.exports = {};\n");

    if (withNativeBinding) {
        const binDir = join(onnxDir, "bin", "napi-v6", process.platform, process.arch);
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, "onnxruntime_binding.node"), "mock native binding");
    }
}

function writePiCachePackage(cacheRoot: string, version: string): string {
    const pluginDir = join(
        cacheRoot,
        "extensions",
        "npm",
        "node_modules",
        "@ufoq",
        "pi-magic-context",
    );
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@ufoq/pi-mini-magic-context", version }),
    );
    return pluginDir;
}

function createMockDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE tags (id INTEGER);
        CREATE TABLE compartments (id INTEGER);
        CREATE TABLE session_meta (id INTEGER);
        INSERT INTO tags VALUES (1);
	`);
    return db;
}

function baseOptions(root: string, cwd: string, prompts: MockPrompts): RunDoctorOptions {
    const storageDir = join(root, ".local", "share", "cortexkit", "mini-magic-context");
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(join(storageDir, "context.db"), "mock");
    return {
        cwd,
        prompts,
        deps: {
            detectPiBinary: () => ({
                path: join(root, ".pi", "bin", "pi"),
                source: "home",
            }),
            getPiVersion: () => "0.74.0",
            getLatestNpmVersion: () => "0.1.0",
            openExistingContextDatabase: () => createMockDb(),
            now: () => new Date("2026-04-28T12:34:56Z"),
            execFileSync: () => {
                throw new Error("gh unavailable");
            },
            spawnSync: () => ({ status: 1, stdout: "", stderr: "not expected" }) as never,
        },
    };
}

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;

    for (const path of tempRoots.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("Pi doctor", () => {
    it("recognizes a local-path install instead of reporting a missing npm package", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);

        // Simulate `pi install <local path>`: Pi records the path verbatim,
        // relative to the settings directory. The package name is only
        // discoverable by reading the manifest it points at.
        const localPkg = join(agentDir, "local-plugin");
        mkdirSync(localPkg, { recursive: true });
        writeFileSync(
            join(localPkg, "package.json"),
            JSON.stringify({ name: "@ufoq/pi-mini-magic-context", version: "0.1.0" }),
        );
        writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({ packages: ["local-plugin"] }),
        );
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain("PASS npm:@ufoq/pi-mini-magic-context is registered");
        expect(output).not.toContain("is missing from packages[]");
    });

    it("still reports a genuinely missing package entry", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({ packages: ["npm:some-other-extension"] }),
        );
        const prompts = new MockPrompts();

        // FAIL lines are printed to stderr rather than through PromptIO.
        const errors: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => {
            errors.push(args.map(String).join(" "));
        };
        let code: number;
        try {
            code = await runDoctor(baseOptions(root, cwd, prompts));
        } finally {
            console.error = originalError;
        }

        expect(code).toBe(1);
        expect(errors.join("\n")).toContain(
            "FAIL npm:@ufoq/pi-mini-magic-context is missing from packages[]",
        );
    });

    it("passes Phase 1 with a healthy mocked environment", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain("PASS Pi 0.74.0 detected");
        expect(output).toContain("PASS npm:@ufoq/pi-mini-magic-context is registered");
        expect(output).toContain("PASS SQLite integrity_check: ok");
        expect(output).toContain("Shared DB row counts: tags=1, compartments=0, session_meta=0");
        expect(output).toContain("Summary: PASS 13 / WARN 1 / FAIL 0");
    });

    it("warns when the local onnxruntime native binding is absent", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        createInstalledPiPlugin(agentDir, false);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain(
            "WARN Embedding provider: local — onnxruntime-node native binding missing",
        );
        expect(output).toContain("postinstall likely failed");
        expect(output).toContain("Stale Pi extension cache found");
        expect(output).toContain("WARN 2");
    });

    it("passes the local embedding check when the onnxruntime native binding is present", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        createInstalledPiPlugin(agentDir, true);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain("PASS Embedding provider: local (native runtime present)");
    });

    it("repairs missing package entry and missing user config in --force mode", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
        writeFileSync(
            join(cwd, ".cortexkit", "mini-magic-context.jsonc"),
            JSON.stringify({ enabled: true }),
        );
        const prompts = new MockPrompts();

        const code = await runDoctor({
            ...baseOptions(root, cwd, prompts),
            force: true,
        });

        expect(code).toBe(0);
        const settings = parseJsonc(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
            packages?: string[];
        };
        expect(settings.packages).toContain("npm:@ufoq/pi-mini-magic-context");
        expect(existsSync(join(root, ".config", "cortexkit", "mini-magic-context.jsonc"))).toBe(
            true,
        );
        const output = prompts.messages.join("\n");
        expect(output).toContain("Added npm:@ufoq/pi-mini-magic-context");
        expect(output).toContain("Wrote default Magic Context config");
        expect(output).toContain("Repair attempted; 2 item(s) changed");
    });

    it("recognizes object-form Magic Context package and preserves object entries during repair", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        const settingsPath = join(agentDir, "settings.json");
        writeFileSync(
            settingsPath,
            JSON.stringify({
                packages: [
                    { name: "npm:@ufoq/pi-mini-magic-context", version: "1.2.3" },
                    { name: "third-party-extension", version: "9.9.9", enabled: true },
                    "npm:other-pi-extension",
                ],
            }),
        );
        writeFileSync(
            join(root, ".config", "cortexkit", "mini-magic-context.jsonc"),
            JSON.stringify({ embedding: { provider: "local" } }),
        );
        writeFileSync(
            join(cwd, ".cortexkit", "mini-magic-context.jsonc"),
            JSON.stringify({ enabled: true }),
        );
        const prompts = new MockPrompts();

        const code = await runDoctor({
            ...baseOptions(root, cwd, prompts),
            force: true,
        });

        expect(code).toBe(0);
        const settings = parseJsonc(readFileSync(settingsPath, "utf-8")) as {
            packages?: unknown[];
        };
        expect(settings.packages).toEqual([
            { name: "npm:@ufoq/pi-mini-magic-context", version: "1.2.3" },
            { name: "third-party-extension", version: "9.9.9", enabled: true },
            "npm:other-pi-extension",
        ]);
        const output = prompts.messages.join("\n");
        expect(output).toContain("PASS npm:@ufoq/pi-mini-magic-context is registered");
        expect(output).not.toContain("Added npm:@ufoq/pi-mini-magic-context");
    });

    it("generates a sanitized markdown report in --issue mode without calling gh create", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        writeFileSync(
            join(tmpdir(), "magic-context.log"),
            `token=abc123\nUser path ${root}/secret with sk-12345678901234567890\n`,
        );
        let ghCreateCalled = false;
        const logged: unknown[] = [];
        const originalConsoleLog = console.log;
        console.log = (...args: unknown[]) => {
            logged.push(...args);
        };
        const prompts = new MockPrompts({
            texts: ["Bug title", `Failure in ${root}`],
        });
        const diagnosticReport: PiDiagnosticReport = {
            timestamp: "2026-04-28T12:34:56.000Z",
            platform: "darwin",
            arch: "arm64",
            nodeVersion: "v24.0.0",
            pluginVersion: "0.1.0",
            piInstalled: true,
            piPath: join(root, ".pi", "bin", "pi"),
            piVersion: "0.74.0",
            settings: {
                path: join(agentDir, "settings.json"),
                exists: true,
                hasMagicContextPackage: true,
                packages: ["npm:@ufoq/pi-mini-magic-context"],
            },
            configPaths: {
                agentDir,
                userConfig: join(root, ".config", "cortexkit", "mini-magic-context.jsonc"),
                projectConfig: join(cwd, ".cortexkit", "mini-magic-context.jsonc"),
            },
            userConfig: {
                path: join(root, ".config", "cortexkit", "mini-magic-context.jsonc"),
                exists: true,
                flags: { embedding: { provider: "local" } },
            },
            projectConfig: {
                path: join(cwd, ".cortexkit", "mini-magic-context.jsonc"),
                exists: true,
                flags: { enabled: true },
            },
            loadedConfigPaths: ["<HOME>/.config/cortexkit/mini-magic-context.jsonc"],
            loadWarnings: [],
            storageDir: {
                path: join(root, ".local", "share", "cortexkit", "mini-magic-context"),
                exists: true,
                contextDbSizeBytes: 4,
            },
            conflicts: { knownConflicts: [], otherPiExtensions: [] },
            logFile: {
                path: join(tmpdir(), "magic-context.log"),
                exists: true,
                sizeKb: 1,
            },
            recentSessions: [],
            historianDumps: {
                byProject: [],
                legacyDumps: {
                    dir: join(tmpdir(), "pi", "magic-context", "historian"),
                    count: 0,
                    recent: [],
                },
            },
        };

        const options = baseOptions(root, cwd, prompts);
        try {
            const code = await runDoctor({
                ...options,
                issue: true,
                deps: {
                    ...options.deps,
                    collectDiagnostics: async () => diagnosticReport,
                    execFileSync: () => {
                        throw new Error("gh unavailable");
                    },
                    spawnSync: () => {
                        ghCreateCalled = true;
                        return { status: 0, stdout: "", stderr: "" } as never;
                    },
                },
            });

            expect(code).toBe(0);
        } finally {
            console.log = originalConsoleLog;
        }

        expect(ghCreateCalled).toBe(false);
        expect(logged.join("\n")).toContain("[pi] Bug title");
        const reportPath = join(cwd, "magic-context-pi-issue-20260428-123456.md");
        expect(existsSync(reportPath)).toBe(true);
        const report = readFileSync(reportPath, "utf-8");
        expect(report).toContain("[pi] Bug title");
        expect(report).toContain("<HOME>");
        expect(report).not.toContain(root);
        expect(report).not.toContain("abc123");
        expect(report).not.toContain("sk-12345678901234567890");
    });

    it("clears stale caches under PI_CODING_AGENT_DIR's parent without touching HOME/.pi/cache", async () => {
        const root = makeTempRoot();
        const home = join(root, "home");
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = join(root, "isolated", "agent");
        process.env.HOME = home;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_DATA_HOME = join(root, "data");
        process.env.XDG_CACHE_HOME = join(root, "cache");
        process.env.XDG_CONFIG_HOME = join(root, "config");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(join(process.env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
        mkdirSync(join(cwd, ".cortexkit"), { recursive: true });
        writeHealthyFiles(agentDir, cwd);
        const isolatedCachePlugin = writePiCachePackage(join(root, "isolated", "cache"), "9.9.9");
        const homeCachePlugin = writePiCachePackage(join(home, ".pi", "cache"), "9.9.9");
        const prompts = new MockPrompts();

        const code = await runDoctor({
            ...baseOptions(root, cwd, prompts),
            force: true,
        });

        expect(code).toBe(0);
        expect(existsSync(isolatedCachePlugin)).toBe(false);
        expect(existsSync(homeCachePlugin)).toBe(true);
        expect(prompts.messages.join("\n")).toContain(
            `Cleared stale Pi extension cache: ${isolatedCachePlugin}`,
        );
    });

    it("reports an unknown CLI version as info instead of pass-current", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        const prompts = new MockPrompts();
        const options = baseOptions(root, cwd, prompts);

        const code = await runDoctor({
            ...options,
            deps: {
                ...options.deps,
                selfVersion: () => "unknown",
            },
        });

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain(
            "INFO Magic Context for Pi CLI version unknown; npm latest is v0.1.0",
        );
        expect(output).not.toContain("PASS Magic Context for Pi CLI vunknown is current");
    });

    it("sanitizes invalid-scheme embedding endpoints before printing them", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        writeFileSync(
            join(root, ".config", "cortexkit", "mini-magic-context.jsonc"),
            JSON.stringify({
                embedding: {
                    provider: "openai-compatible",
                    endpoint: "ftp://user:pass@example.com/v1?api_key=secret",
                    model: "text-embedding-3-small",
                },
            }),
        );
        const prompts = new MockPrompts();
        const options = baseOptions(root, cwd, prompts);
        const errors: string[] = [];
        const originalError = console.error;
        console.error = (message?: unknown) => {
            errors.push(String(message));
        };
        try {
            const code = await runDoctor({
                ...options,
                deps: {
                    ...options.deps,
                    probeEmbeddingEndpoint: async () => ({
                        kind: "invalid_scheme",
                        endpoint: "ftp://user:pass@example.com/v1?api_key=secret",
                    }),
                },
            });

            expect(code).toBe(1);
        } finally {
            console.error = originalError;
        }

        const output = errors.join("\n");
        expect(output).toContain("ftp://example.com/v1");
        expect(output).not.toContain("user:pass");
        expect(output).not.toContain("api_key=secret");
    });

    it("sanitizes thrown embedding probe errors before printing them", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        writeFileSync(
            join(root, ".config", "cortexkit", "mini-magic-context.jsonc"),
            JSON.stringify({
                embedding: {
                    provider: "openai-compatible",
                    endpoint: "https://example.com/v1",
                    model: "text-embedding-3-small",
                },
            }),
        );
        const prompts = new MockPrompts();
        const options = baseOptions(root, cwd, prompts);
        const errors: string[] = [];
        const originalError = console.error;
        console.error = (message?: unknown) => {
            errors.push(String(message));
        };
        try {
            const code = await runDoctor({
                ...options,
                deps: {
                    ...options.deps,
                    probeEmbeddingEndpoint: async () => {
                        throw new Error("token=abc123 from /Users/alice/private");
                    },
                },
            });

            expect(code).toBe(1);
        } finally {
            console.error = originalError;
        }

        const output = errors.join("\n");
        expect(output).toContain("Embedding probe threw: token=<REDACTED:token>");
        expect(output).toContain("/Users/<USER>/private");
        expect(output).not.toContain("alice");
        expect(output).not.toContain("token=abc123");
    });
});
