import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCortexKitUserConfigPath } from "@ufoq/mini-magic-context-core/config/paths";
import { getMagicContextLogPath as getMagicContextLogPathCore } from "@ufoq/mini-magic-context-core/shared/data-path";

// ============================================================================
// Pi paths
// ============================================================================

function envFirstHomeDir(): string {
    const home = process.env.HOME?.trim();
    return home || homedir();
}

/** Pi's per-user agent dir; overridable via PI_CODING_AGENT_DIR. */
export function getPiAgentDir(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
    if (envDir) return envDir;
    return join(envFirstHomeDir(), ".pi", "agent");
}

/** Pi's per-user agent dir; overridable via PI_CODING_AGENT_DIR. */
export function getPiAgentConfigDir(): string {
    return getPiAgentDir();
}

/** Pi session JSONL root (`<agentDir>/sessions`). */
export function getPiSessionsRoot(): string {
    return join(getPiAgentDir(), "sessions");
}

/** Pi cache root, kept beside the resolved agent dir (`<parent>/cache`). */
export function getPiCacheRoot(): string {
    return join(dirname(getPiAgentDir()), "cache");
}

/** Shared Magic Context user config, independent of the Pi agent settings dir. */
export function getPiUserConfigPath(): string {
    return resolveCortexKitUserConfigPath();
}

/**
 * Pi's `pi install <source>` command persists extension package sources in
 * the `packages` array inside ~/.pi/agent/settings.json.
 */
export function getPiUserExtensionsPath(): string {
    return join(getPiAgentConfigDir(), "settings.json");
}

// ============================================================================
// Plugin / shared paths
// ============================================================================

/** Pi plugin log file path. */
export function getMagicContextLogPath(): string {
    return getMagicContextLogPathCore();
}

/** True if `path` exists and is a directory. */
export function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** Recursive size in bytes of a directory; returns 0 if missing. */
export function dirSizeBytes(path: string): number {
    if (!isDir(path)) return 0;
    let total = 0;
    const stack = [path];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (cur === undefined) break;
        try {
            const entries = readdirSync(cur, { withFileTypes: true });
            for (const entry of entries) {
                const child = join(cur, entry.name);
                if (entry.isDirectory()) {
                    stack.push(child);
                } else if (entry.isFile()) {
                    try {
                        total += statSync(child).size;
                    } catch {
                        // ignore unreadable
                    }
                }
            }
        } catch {
            // ignore unreadable directories
        }
    }
    return total;
}
