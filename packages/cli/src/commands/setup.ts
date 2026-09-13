/**
 * `setup` command.
 *
 * Resolves the harness target via `--harness` flag or auto-detection
 * (`resolveAdaptersForCommand`), then dispatches to the Pi setup wizard.
 */
import type { HarnessAdapter } from "../adapters/types";
import { resolveAdaptersForCommand } from "../lib/harness-select";
import { intro, log, note, outro } from "../lib/prompts";
import { runSetup as runPiSetup } from "./setup-pi";

export async function runSetup(argv: string[]): Promise<number> {
    const dryRun = argv.includes("--dry-run");
    intro(dryRun ? "Magic Context setup (dry run)" : "Magic Context setup");

    let adapters: HarnessAdapter[];
    try {
        adapters = await resolveAdaptersForCommand(argv, {
            allowMulti: false,
            verb: "setup",
        });
    } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        outro("Setup stopped — correct the command arguments and try again.");
        return 1;
    }

    if (adapters.length === 0) {
        outro("No harness selected. Nothing to do.");
        return 0;
    }

    let anyFailure = false;
    for (const adapter of adapters) {
        log.step(`Configuring ${adapter.displayName} (${adapter.pluginPackageName})…`);

        const code = await dispatchSetup(adapter, dryRun);
        if (code !== 0) {
            anyFailure = true;
            continue;
        }
        if (!dryRun) printNextSteps(adapter);
    }

    if (anyFailure) {
        outro("Setup finished with warnings — see above.");
        return 1;
    }
    outro(dryRun ? "Dry run done — no changes were made." : "Done.");
    return 0;
}

async function dispatchSetup(adapter: HarnessAdapter, dryRun: boolean): Promise<number> {
    switch (adapter.kind) {
        case "pi":
            return runPiSetup({ dryRun });
    }
}

function printNextSteps(adapter: HarnessAdapter): void {
    if (adapter.kind === "pi") {
        note(
            [
                "Restart your Pi session so the extension registers.",
                "Verify with: npx @ufoq/mini-magic-context@latest doctor --harness pi",
            ].join("\n"),
            "Next steps",
        );
    }
}
