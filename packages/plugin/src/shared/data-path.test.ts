import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    ensureCortexKitArtifactGitignore,
    getDataDir,
    getMagicContextLogPath,
    getMagicContextStorageDir,
    getProjectMagicContextDir,
    getProjectMagicContextHistorianDir,
} from "./data-path";

const savedEnv = {
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
};

describe("data-path", () => {
    beforeEach(() => {
        process.env.XDG_CACHE_HOME = undefined;
        process.env.XDG_DATA_HOME = undefined;
        process.env.LOCALAPPDATA = undefined;
        process.env.MAGIC_CONTEXT_LOG_PATH = undefined;
        // Bun's env handling: explicit delete for unset
        delete process.env.XDG_CACHE_HOME;
        delete process.env.XDG_DATA_HOME;
        delete process.env.LOCALAPPDATA;
        delete process.env.MAGIC_CONTEXT_LOG_PATH;
    });

    afterEach(() => {
        if (savedEnv.XDG_CACHE_HOME !== undefined)
            process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
        if (savedEnv.XDG_DATA_HOME !== undefined)
            process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
        if (savedEnv.LOCALAPPDATA !== undefined) process.env.LOCALAPPDATA = savedEnv.LOCALAPPDATA;
        if (savedEnv.MAGIC_CONTEXT_LOG_PATH !== undefined)
            process.env.MAGIC_CONTEXT_LOG_PATH = savedEnv.MAGIC_CONTEXT_LOG_PATH;
        else delete process.env.MAGIC_CONTEXT_LOG_PATH;
    });

    test("getDataDir falls back to <homedir>/.local/share when XDG_DATA_HOME is unset", () => {
        expect(getDataDir()).toBe(path.join(os.homedir(), ".local", "share"));
    });

    test("getMagicContextStorageDir uses cortexkit/mini-magic-context layout", () => {
        expect(getMagicContextStorageDir()).toBe(
            path.join(os.homedir(), ".local", "share", "cortexkit", "mini-magic-context"),
        );
    });

    test("getMagicContextStorageDir honors XDG_DATA_HOME", () => {
        process.env.XDG_DATA_HOME = "/tmp/custom-data";
        expect(getMagicContextStorageDir()).toBe(
            path.join("/tmp/custom-data", "cortexkit", "mini-magic-context"),
        );
    });

    test("getProjectMagicContextDir composes <project>/.cortexkit/mini-magic-context", () => {
        // Project-local artifacts (historian state file, failure dumps) live
        // inside the project so OpenCode's external_directory permission system
        // treats them as project-internal. Without this, historian's Read tool
        // would trigger a permission prompt on every run when artifacts lived
        // under os.tmpdir(). Moved from .opencode/ to the shared .cortexkit/.
        expect(getProjectMagicContextDir("/Users/me/Work/proj")).toBe(
            path.join("/Users/me/Work/proj", ".cortexkit", "mini-magic-context"),
        );
    });

    test("getProjectMagicContextHistorianDir appends historian/", () => {
        expect(getProjectMagicContextHistorianDir("/Users/me/Work/proj")).toBe(
            path.join("/Users/me/Work/proj", ".cortexkit", "mini-magic-context", "historian"),
        );
    });

    test("getProjectMagicContextDir is unaffected by XDG_DATA_HOME", () => {
        // Project-local paths anchor to the project directory the caller
        // passes in, NOT to any user-config env var. Setting XDG_DATA_HOME
        // (which changes the shared storage dir) must not change the
        // project-local historian dir.
        process.env.XDG_DATA_HOME = "/tmp/custom-data";
        expect(getProjectMagicContextDir("/some/project")).toBe(
            path.join("/some/project", ".cortexkit", "mini-magic-context"),
        );
    });

    test("getProjectMagicContextDir handles trailing slashes via path.join", () => {
        // path.join normalizes redundant separators so callers don't need to
        // worry about how the project directory was constructed.
        expect(getProjectMagicContextDir("/some/project/")).toBe(
            path.join("/some/project/", ".cortexkit", "mini-magic-context"),
        );
    });

    test("getMagicContextLogPath falls back to the Pi temp dir when the env override is unset", () => {
        expect(getMagicContextLogPath()).toBe(
            path.join(os.tmpdir(), "pi", "magic-context", "magic-context.log"),
        );
    });

    test("getMagicContextLogPath honors MAGIC_CONTEXT_LOG_PATH", () => {
        process.env.MAGIC_CONTEXT_LOG_PATH = "/tmp/custom/magic-context.log";
        expect(getMagicContextLogPath("pi")).toBe("/tmp/custom/magic-context.log");
    });

    test("getMagicContextLogPath ignores a blank MAGIC_CONTEXT_LOG_PATH", () => {
        process.env.MAGIC_CONTEXT_LOG_PATH = "   ";
        expect(getMagicContextLogPath("pi")).toBe(
            path.join(os.tmpdir(), "pi", "magic-context", "magic-context.log"),
        );
    });
});

describe("ensureCortexKitArtifactGitignore", () => {
    test("creates .cortexkit/.gitignore with a fenced mini-magic-context block", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "mc-gi-"));
        try {
            ensureCortexKitArtifactGitignore(dir);
            const gi = readFileSync(path.join(dir, ".cortexkit", ".gitignore"), "utf8");
            expect(gi).toContain("# >>> cortexkit:mini-magic-context");
            expect(gi).toContain("mini-magic-context/");
            expect(gi).toContain("# <<< cortexkit:mini-magic-context");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("is idempotent — a second call does not duplicate the block", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "mc-gi-"));
        try {
            ensureCortexKitArtifactGitignore(dir);
            ensureCortexKitArtifactGitignore(dir);
            const gi = readFileSync(path.join(dir, ".cortexkit", ".gitignore"), "utf8");
            const occurrences = gi.split("# >>> cortexkit:mini-magic-context").length - 1;
            expect(occurrences).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("preserves a sibling module's existing entries (appends, never clobbers)", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "mc-gi-"));
        try {
            const ckDir = path.join(dir, ".cortexkit");
            mkdirSync(ckDir, { recursive: true });
            // Simulate a sibling (e.g. AFT) already owning a fenced block.
            writeFileSync(
                path.join(ckDir, ".gitignore"),
                "# >>> cortexkit:aft\naft/scratch/\n# <<< cortexkit:aft\n",
            );
            ensureCortexKitArtifactGitignore(dir);
            const gi = readFileSync(path.join(ckDir, ".gitignore"), "utf8");
            expect(gi).toContain("# >>> cortexkit:aft");
            expect(gi).toContain("aft/scratch/");
            expect(gi).toContain("# >>> cortexkit:mini-magic-context");
            expect(gi).toContain("mini-magic-context/");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("does not ignore the project config — only the artifact dir", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "mc-gi-"));
        try {
            ensureCortexKitArtifactGitignore(dir);
            const gi = readFileSync(path.join(dir, ".cortexkit", ".gitignore"), "utf8");
            // The config file stays tracked: it must NOT appear as an ignore.
            expect(gi).not.toContain("mini-magic-context.jsonc");
            expect(gi).not.toContain("*.jsonc");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
