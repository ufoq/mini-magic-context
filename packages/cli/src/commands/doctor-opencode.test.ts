import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import {
    collectNpmReleaseAgeWarnings,
    getUserNpmrcPath,
    isPinnedOpenCodePluginSpecifier,
} from "./doctor-opencode";
import { clearPluginCache } from "./doctor-opencode-cache";

const tempDirs: string[] = [];
let originalXdgCacheHome: string | undefined;
let originalHome: string | undefined;
let originalNpmUserConfig: string | undefined;

function makeTempDir(prefix = "mc-doctor-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    if (originalXdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
    } else {
        process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }
    if (originalNpmUserConfig === undefined) {
        delete process.env.NPM_CONFIG_USERCONFIG;
    } else {
        process.env.NPM_CONFIG_USERCONFIG = originalNpmUserConfig;
    }
    originalXdgCacheHome = undefined;
    originalHome = undefined;
    originalNpmUserConfig = undefined;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function createCachedOpenCodePlugin(
    root: string,
    version: string,
    entry = OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
): string {
    const pluginCachePath = join(root, "opencode", "packages", entry);
    const installedPackagePath = join(
        pluginCachePath,
        "node_modules",
        "@ufoq",
        "opencode-mini-magic-context",
        "package.json",
    );
    mkdirSync(dirname(installedPackagePath), { recursive: true });
    writeFileSync(installedPackagePath, `${JSON.stringify({ version })}\n`);
    return pluginCachePath;
}

describe("doctor OpenCode plugin cache", () => {
    it("clears stale @latest cache when cached plugin is older than npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.26.0",
            latest: "0.29.1",
            path: pluginCachePath,
        });
        expect(existsSync(pluginCachePath)).toBe(false);
    });

    it("keeps @latest cache when cached plugin matches npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "up_to_date",
            cached: "0.29.1",
            latest: "0.29.1",
            path: pluginCachePath,
        });
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("clears stale versionless cache even when @latest cache is current", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const latestCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");
        const versionlessCachePath = createCachedOpenCodePlugin(
            cacheRoot,
            "0.26.0",
            OPENCODE_PLUGIN_NAME,
        );

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.26.0",
            latest: "0.29.1",
            path: versionlessCachePath,
            paths: [versionlessCachePath],
        });
        expect(existsSync(latestCachePath)).toBe(true);
        expect(existsSync(versionlessCachePath)).toBe(false);
    });

    it("preserves existing cache when plugin npm latest is unavailable", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ latestVersion: null });

        expect(result).toMatchObject({
            action: "check_unavailable",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("force-clears existing cache even when plugin npm latest is unavailable", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ force: true, latestVersion: null });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(false);
    });

    it("reports the actually-failed root and clears the rest when one root fails", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const latestCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");
        const versionlessCachePath = createCachedOpenCodePlugin(
            cacheRoot,
            "0.26.0",
            OPENCODE_PLUGIN_NAME,
        );

        // Fail only the second root: the first must still be removed, and the
        // error must point at the failed root, not the already-removed one.
        const removed: string[] = [];
        const result = await clearPluginCache(
            { latestVersion: "0.29.1" },
            {
                remove: (path) => {
                    if (path === versionlessCachePath) {
                        throw new Error("EACCES: permission denied");
                    }
                    rmSync(path, { recursive: true, force: true });
                    removed.push(path);
                },
            },
        );

        expect(result).toMatchObject({
            action: "error",
            path: versionlessCachePath,
            paths: [versionlessCachePath],
            clearedPaths: [latestCachePath],
            failedPaths: [versionlessCachePath],
            error: "EACCES: permission denied",
        });
        expect(removed).toEqual([latestCachePath]);
        expect(existsSync(latestCachePath)).toBe(false);
    });
});

describe("doctor OpenCode helper logic", () => {
    it("treats dist-tags like @next and @beta as pinned plugin entries", () => {
        expect(isPinnedOpenCodePluginSpecifier("@ufoq/opencode-mini-magic-context@next")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@ufoq/opencode-mini-magic-context@beta")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@ufoq/opencode-mini-magic-context@0.29.1")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@ufoq/opencode-mini-magic-context")).toBe(false);
        expect(isPinnedOpenCodePluginSpecifier("@ufoq/opencode-mini-magic-context@latest")).toBe(
            false,
        );
    });

    it("honors NPM_CONFIG_USERCONFIG before HOME for npmrc release-age warnings", () => {
        const root = makeTempDir("mc-npmrc-");
        const home = join(root, "home");
        const customNpmrc = join(root, "custom.npmrc");
        originalHome = process.env.HOME;
        originalNpmUserConfig = process.env.NPM_CONFIG_USERCONFIG;
        process.env.HOME = home;
        process.env.NPM_CONFIG_USERCONFIG = customNpmrc;
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, ".npmrc"), "min-release-age=9999\n");
        writeFileSync(customNpmrc, "before=2026-01-01\n");

        expect(getUserNpmrcPath()).toBe(customNpmrc);
        expect(collectNpmReleaseAgeWarnings()).toEqual([`${customNpmrc} has 'before=2026-01-01'`]);
    });
});
