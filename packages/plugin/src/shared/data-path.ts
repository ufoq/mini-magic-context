import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getDataDir(): string {
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

/** Pi scratch directory under the operating system temp directory. */
export function getMagicContextTempDir(): string {
    return path.join(os.tmpdir(), "pi", "magic-context");
}

/** Standard Pi plugin log path. */
export function getMagicContextLogPath(): string {
    // An explicit override wins over the temp-dir default, so users on
    // sandboxed/ephemeral setups (Docker, CI) can point the diagnostic log at a
    // persistent or shared path. Blank/whitespace is treated as unset.
    const envPath = process.env.MAGIC_CONTEXT_LOG_PATH?.trim();
    if (envPath) return envPath;
    return path.join(getMagicContextTempDir(), "magic-context.log");
}

/**
 * Project-local magic-context artifact directory.
 *
 * Layout: `<project-directory>/.cortexkit/mini-magic-context/`
 *
 * Used for transient historian/recomp artifacts that the model reads during a
 * run. Keeping them inside the project avoids external-directory prompts and
 * the generated `.gitignore` block prevents them from dirtying the repository.
 *
 * Logger does NOT use this — log files stay in the Pi temp subtree
 * because they are written by the plugin process itself (no model-side Read
 * tool call, no permission prompt) and span sessions/projects.
 */
export function getProjectMagicContextDir(directory: string): string {
    return path.join(directory, ".cortexkit", "mini-magic-context");
}

const GITIGNORE_GUARD_OPEN = "# >>> cortexkit:mini-magic-context";
const GITIGNORE_GUARD_CLOSE = "# <<< cortexkit:mini-magic-context";

/**
 * Ensure `<project>/.cortexkit/.gitignore` ignores Magic Context's transient
 * artifact subdir (`mini-magic-context/`) without touching anything else in the
 * shared `.cortexkit/` dir — the project config `mini-magic-context.jsonc` stays
 * tracked, and any sibling module's (e.g. AFT's) entries are preserved.
 *
 * Uses the shared CortexKit fenced-block convention: each module owns exactly
 * its `# >>> cortexkit:<module>` … `# <<< cortexkit:<module>` block and appends
 * it idempotently (no-op when its own guard line is already present). This lets
 * multiple cortexkit modules coexist in one `.gitignore` without clobbering.
 *
 * Best-effort: a write failure never blocks an artifact write (the caller
 * already degrades gracefully on its own write failures).
 */
export function ensureCortexKitArtifactGitignore(directory: string): void {
    try {
        const cortexKitDir = path.join(directory, ".cortexkit");
        const gitignorePath = path.join(cortexKitDir, ".gitignore");
        let existing = "";
        if (existsSync(gitignorePath)) {
            existing = readFileSync(gitignorePath, "utf8");
            // Already fenced by us — nothing to do.
            if (existing.includes(GITIGNORE_GUARD_OPEN)) return;
        }
        const block = `${GITIGNORE_GUARD_OPEN}\nmini-magic-context/\n${GITIGNORE_GUARD_CLOSE}\n`;
        const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
        const next = existing + (needsLeadingNewline ? "\n" : "") + block;
        mkdirSync(cortexKitDir, { recursive: true });
        writeFileSync(gitignorePath, next, "utf8");
    } catch {
        // best-effort — never block an artifact write on the gitignore.
    }
}

/**
 * Project-local historian artifact directory.
 *
 * Layout: `<project-directory>/.cortexkit/mini-magic-context/historian/`
 *
 * Used for:
 *   - existing-state offload XMLs that long historian/recomp passes write
 *     before invoking the model (the model reads the file via Read tool)
 *   - validation-failure dump XMLs preserved for debugging
 *
 * Callers must `mkdirSync(dir, { recursive: true })` before writing — the
 * `.opencode/` parent may not exist on a fresh project, and write failures
 * here must degrade gracefully (e.g. historian falls back to inline state).
 */
export function getProjectMagicContextHistorianDir(directory: string): string {
    return path.join(getProjectMagicContextDir(directory), "historian");
}

/**
 * Resolve the mini-magic-context storage directory.
 *
 * Mini Magic Context keeps a dedicated fresh-install database and never opens
 * or mutates databases owned by another product.
 *
 * Layout: <XDG_DATA_HOME>/cortexkit/mini-magic-context/
 */
export function getMagicContextStorageDir(): string {
    return path.join(getDataDir(), "cortexkit", "mini-magic-context");
}
