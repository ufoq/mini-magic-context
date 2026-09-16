import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MagicContextConfigSchema } from "@ufoq/mini-magic-context-core/config/schema/magic-context";
import { loadPiConfig } from "./index";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(path);
	return path;
}

function withHome(home: string): void {
	process.env.HOME = home;
	// The user config base is `(XDG_CONFIG_HOME ?? <HOME>/.config)/cortexkit/...`.
	// writeUserConfig() writes under `<HOME>/.config`, so pin XDG_CONFIG_HOME to
	// match — otherwise a CI runner that exports its own XDG_CONFIG_HOME makes the
	// loader look elsewhere and these tests read schema defaults (the green-on-my-
	// machine / red-in-CI hermeticity gap this guards against).
	process.env.XDG_CONFIG_HOME = join(home, ".config");
}

function writeConfig(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf-8");
}

// Hard cutover: both harnesses read config from the shared CortexKit location.
// Project config: <cwd>/.cortexkit/mini-magic-context.*
// User config:    <configHome>/cortexkit/mini-magic-context.* where configHome is
//                 XDG_CONFIG_HOME ?? <HOME>/.config (XDG_CONFIG_HOME is unset in
//                 the test env, so it resolves under the temp HOME below).
function writeProjectConfig(
	cwd: string,
	text: string,
	extension: "jsonc" | "json" = "jsonc",
): string {
	const path = join(cwd, ".cortexkit", `mini-magic-context.${extension}`);
	writeConfig(path, text);
	return path;
}

function writeUserConfig(
	home: string,
	text: string,
	extension: "jsonc" | "json" = "jsonc",
): string {
	const path = join(
		home,
		".config",
		"cortexkit",
		`mini-magic-context.${extension}`,
	);
	writeConfig(path, text);
	return path;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	}

	for (const path of tempRoots.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("loadPiConfig", () => {
	it("returns defaults with no config files", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);

		const result = loadPiConfig({ cwd });

		expect(result.config).toEqual(MagicContextConfigSchema.parse({}));
		expect(result.warnings).toEqual([]);
		expect(result.loadedFromPaths).toEqual([]);
	});

	it("loads project config only", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		const projectPath = writeProjectConfig(
			cwd,
			`{
                // JSONC comments and trailing commas are accepted.
                "enabled": false,
            }`,
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.enabled).toBe(false);
		expect(result.warnings).toEqual([]);
		expect(result.loadedFromPaths).toEqual([projectPath]);
	});

	it("ignores removed transform_mode setting", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		writeUserConfig(home, JSON.stringify({ transform_mode: "rust" }));

		const result = loadPiConfig({ cwd });

		expect(result.config).not.toHaveProperty("transform_mode");
	});

	it("loads user config only", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		const userPath = writeUserConfig(home, '{ "smart_drops": true }', "json");

		const result = loadPiConfig({ cwd });

		expect(result.config.smart_drops).toBe(true);
		expect(result.loadedFromPaths).toEqual([userPath]);
	});

	it("merges user then project with project overrides winning", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		const projectPath = writeProjectConfig(
			cwd,
			JSON.stringify({
				clear_reasoning_age: 60,
			}),
		);
		const userPath = writeUserConfig(
			home,
			JSON.stringify({
				clear_reasoning_age: 40,
			}),
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.clear_reasoning_age).toBe(60);
		expect(result.loadedFromPaths).toEqual([projectPath, userPath]);
	});

	it("warns and falls back to defaults for invalid JSONC", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		const projectPath = writeProjectConfig(cwd, '{ "enabled": false,, }');

		const result = loadPiConfig({ cwd });

		expect(result.config).toEqual(MagicContextConfigSchema.parse({}));
		expect(result.loadedFromPaths).toEqual([projectPath]);
		expect(result.warnings.join("\n")).toContain("failed to load config");
		expect(result.warnings.join("\n")).toContain("using defaults");
	});

	it("warns and falls back to defaults for invalid Zod fields", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		writeProjectConfig(
			cwd,
			JSON.stringify({
				enabled: false,
				clear_reasoning_age: 3,
			}),
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.enabled).toBe(false);
		expect(result.config.clear_reasoning_age).toBe(
			MagicContextConfigSchema.parse({}).clear_reasoning_age,
		);
		expect(result.warnings.join("\n")).toContain("clear_reasoning_age");
		expect(result.warnings.join("\n")).toContain("using default");
	});

	it("strips language from PROJECT config but honors USER config", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		writeUserConfig(home, JSON.stringify({ language: "pt" }));
		writeProjectConfig(cwd, JSON.stringify({ language: "tr" }));

		const result = loadPiConfig({ cwd });

		expect(result.config.language).toBe("pt");
		expect(result.warnings.join("\n")).toContain(
			"Ignoring language from project config",
		);
	});

	it("keeps historian model selection user-owned when project config tries to override it", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		writeUserConfig(
			home,
			JSON.stringify({
				historian: {
					model: "anthropic/user-historian",
					fallback_models: ["anthropic/user-fallback"],
				},
			}),
		);
		writeProjectConfig(
			cwd,
			JSON.stringify({
				historian: {
					model: "anthropic/project-historian",
					fallback_models: ["anthropic/project-fallback"],
					temperature: 0.2,
				},
			}),
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.historian?.model).toBe("anthropic/user-historian");
		expect(result.config.historian?.fallback_models).toEqual([
			"anthropic/user-fallback",
		]);
		expect(result.config.historian?.temperature).toBe(0.2);
		expect(result.warnings.join("\n")).toContain(
			"Ignoring historian.model/fallback_models",
		);
	});
});
