/**
 * Harness selection logic for the Magic Context CLI.
 *
 * Resolves which adapter(s) a command should target based on:
 *   1. `--harness pi` flag (hard override, no prompts)
 *   2. Auto-detect the installed harness
 */
import { getAdapter, getInstalledAdapters } from "../adapters";
import type { HarnessAdapter, HarnessKind } from "../adapters/types";
import { log, selectOne } from "./prompts";

type HarnessFlagResult =
    | { kind: "absent" }
    | { kind: "valid"; harness: HarnessKind }
    | { kind: "invalid"; value: string | null };

function parseHarnessFlag(argv: string[]): HarnessFlagResult {
    const idx = argv.indexOf("--harness");
    if (idx === -1) return { kind: "absent" };
    const value = argv[idx + 1];
    if (!value || value.startsWith("--")) return { kind: "invalid", value: null };
    if (value === "pi") return { kind: "valid", harness: value };
    return { kind: "invalid", value };
}

export interface ResolveOptions {
    /** Allow the user to select multiple harnesses at once. Setup defaults to single. */
    allowMulti: boolean;
    /** Verb used in prompts ("setup" / "diagnose"). */
    verb: string;
}

/**
 * Resolve which adapter(s) to act on for the given command invocation.
 *
 * Decision tree:
 *   - `--harness pi` → return that single adapter (hard override)
 *   - not installed → prompt the user to pick (gives the install hint)
 *   - installed → use it
 */
export async function resolveAdaptersForCommand(
    argv: string[],
    options: ResolveOptions,
): Promise<HarnessAdapter[]> {
    const flag = parseHarnessFlag(argv);
    if (flag.kind === "valid") return [getAdapter(flag.harness)];
    if (flag.kind === "invalid") {
        throw new Error(
            flag.value === null
                ? "Missing value for --harness (expected pi)"
                : `Invalid --harness value: ${flag.value} (expected pi)`,
        );
    }

    const installed = getInstalledAdapters();

    if (installed.length === 0) {
        log.warn("No supported harness was detected on PATH (pi).");
        const pick = await selectOne(`Which harness do you want to ${options.verb}?`, [
            {
                label: "Pi",
                value: "pi",
                hint: "@ufoq/pi-mini-magic-context",
            },
        ]);
        return [getAdapter(pick as HarnessKind)];
    }

    const only = installed[0];
    log.info(`Detected ${only.displayName} — using it for ${options.verb}.`);
    return [only];
}
