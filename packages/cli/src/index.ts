#!/usr/bin/env node
/**
 * @ufoq/mini-magic-context — unified CLI for Mini Magic Context.
 *
 * Subcommands:
 *   setup           Interactive setup wizard for Pi.
 *   doctor          Health-check + auto-fix for the installed harness.
 *     --force         Force-clear plugin cache.
 *     --issue         Bundle a sanitized issue report and submit/open.
 *     --clear         Interactive picker to clear plugin caches.
 *
 * Common flags:
 *   --harness pi            Target the Pi harness (default: auto-detect / prompt)
 *   --version, -v           Print CLI version and exit
 *   --help, -h              Print help and exit
 */
import { createRequire } from "node:module";
import { isPromptCancelledError } from "./lib/prompts";

const REMOVED_DOCTOR_ARGUMENTS = new Set([
    "--check-v22-backfill",
    "--retry-v22-backfill",
    "--rekey-v22-dir-identity",
    "drain-authority",
    "merge-identity",
]);

function getVersion(): string {
    const req = createRequire(import.meta.url);
    // In source layout (src/index.ts) package.json is two levels up.
    // In published layout (dist/index.js) it's one level up. Try both so
    // `--version` works regardless of how the binary was launched.
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
                return pkg.version;
            }
        } catch {
            // try next layout
        }
    }
    return "0.0.0";
}

function printUsage(): void {
    console.log("");
    console.log("  Mini Magic Context CLI");
    console.log("  ──────────────────────");
    console.log("");
    console.log("  Commands:");
    console.log("    setup            Interactive setup wizard");
    console.log("    doctor           Check and fix configuration issues");
    console.log("    doctor --force   Force-clear plugin cache");
    console.log("    doctor --issue   Collect diagnostics and open a GitHub issue");
    console.log("    doctor --clear   Interactive cache cleanup picker");
    console.log("");
    console.log("  Harness selection:");
    console.log("    --harness pi          Target Pi only");
    console.log("    (default: auto-detect, prompt if not installed)");
    console.log("");
    console.log("  Usage:");
    console.log("    npx @ufoq/mini-magic-context@latest setup");
    console.log("        # add --dry-run to preview the wizard without writing any files");
    console.log("    npx @ufoq/mini-magic-context@latest doctor");
    console.log("    npx @ufoq/mini-magic-context@latest doctor --issue");
    console.log("");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
        printUsage();
        return 0;
    }

    if (argv[0] === "--version" || argv[0] === "-v") {
        console.log(getVersion());
        return 0;
    }

    const command = argv[0];
    const rest = argv.slice(1);

    try {
        if (command === "setup") {
            const { runSetup } = await import("./commands/setup");
            return runSetup(rest);
        }

        if (command === "doctor") {
            if (rest.some((argument) => REMOVED_DOCTOR_ARGUMENTS.has(argument))) {
                console.error(`Unknown doctor command: ${rest[0]}`);
                return 1;
            }
            const { runDoctor } = await import("./commands/doctor");
            return runDoctor({
                force: rest.includes("--force"),
                issue: rest.includes("--issue"),
                clear: rest.includes("--clear"),
                argv: rest,
            });
        }
    } catch (error) {
        if (isPromptCancelledError(error)) return 0;
        throw error;
    }

    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
