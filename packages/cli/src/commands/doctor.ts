/**
 * `doctor` command.
 *
 * Dispatches to the Pi doctor based on `--harness` or auto-detection.
 * Supports `--force` and `--issue` flags.
 */
import { getInstalledAdapters } from "../adapters";
import type { HarnessAdapter } from "../adapters/types";
import { resolveAdaptersForCommand } from "../lib/harness-select";
import { confirm, intro, log, outro, selectMany, spinner } from "../lib/prompts";
import { doctor as runPiDoctor } from "./doctor-pi";

export interface RunDoctorOptions {
    force?: boolean;
    issue?: boolean;
    clear?: boolean;
    argv?: string[];
}

export async function runDoctor(options: RunDoctorOptions): Promise<number> {
    if (options.clear) return runClear();

    const argv = options.argv ?? [];
    const adapters = await resolveAdaptersForCommand(argv, {
        allowMulti: true,
        verb: "diagnose",
    });

    if (adapters.length === 0) {
        log.warn("No harness selected.");
        return 0;
    }

    let anyFailure = false;
    for (const adapter of adapters) {
        log.step(`Running doctor for ${adapter.displayName}…`);
        const code = await dispatchDoctor(adapter, options);
        if (code !== 0) anyFailure = true;
    }
    return anyFailure ? 1 : 0;
}

async function dispatchDoctor(adapter: HarnessAdapter, options: RunDoctorOptions): Promise<number> {
    switch (adapter.kind) {
        case "pi": {
            const piArgs: string[] = [];
            if (options.force) piArgs.push("--force");
            if (options.issue) piArgs.push("--issue");
            return runPiDoctor(piArgs);
        }
    }
}

/**
 * Interactive cache-clear flow. Presents a picker showing cleanable caches
 * across installed harnesses with their current sizes; the user selects
 * which to clear.
 */
async function runClear(): Promise<number> {
    intro("Magic Context — Clear caches");

    const installed = getInstalledAdapters();
    if (installed.length === 0) {
        log.warn("No installed harnesses detected. Nothing to clear.");
        outro("Done.");
        return 0;
    }

    const items: { adapter: HarnessAdapter; path: string; sizeBytes: number }[] = [];
    for (const adapter of installed) {
        const cache = adapter.getPluginCacheInfo();
        if (cache.path && cache.exists) {
            items.push({ adapter, path: cache.path, sizeBytes: cache.sizeBytes });
        }
    }

    if (items.length === 0) {
        log.info("No clearable plugin caches found across installed harnesses.");
        outro("Done.");
        return 0;
    }

    const picks = await selectMany(
        "Select caches to clear:",
        items.map((item, idx) => ({
            label: `${item.adapter.displayName}: ${formatSize(item.sizeBytes)} — ${item.path}`,
            value: String(idx),
        })),
    );

    if (picks.length === 0) {
        log.info("Nothing selected. Done.");
        outro("Done.");
        return 0;
    }

    const confirmed = await confirm(
        `Delete ${picks.length} cache director${picks.length === 1 ? "y" : "ies"}? This is irreversible.`,
        false,
    );
    if (!confirmed) {
        log.info("Cancelled.");
        outro("Done.");
        return 0;
    }

    let failed = 0;
    for (const idxStr of picks) {
        const idx = Number.parseInt(idxStr, 10);
        const item = items[idx];
        if (!item) continue;
        const s = spinner();
        s.start(`Clearing ${item.path}`);
        try {
            const { existsSync, rmSync } = await import("node:fs");
            if (existsSync(item.path)) {
                rmSync(item.path, { recursive: true, force: true });
            }
            s.stop(`Cleared ${item.path}`);
        } catch (err) {
            s.stop(`Failed: ${item.path}`);
            log.error((err as Error).message);
            failed += 1;
        }
    }

    outro(failed === 0 ? "Done." : `Done with ${failed} failure(s).`);
    return failed === 0 ? 0 : 1;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
