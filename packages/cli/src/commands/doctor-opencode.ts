import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { substituteConfigVariables } from "@magic-context/core/config/variable";
import {
    type EmbeddingProbeOutcome,
    probeEmbeddingEndpoint,
} from "@magic-context/core/features/magic-context/memory/embedding-probe";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import { fixConflicts } from "@magic-context/core/shared/conflict-fixer";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { parse, stringify } from "comment-json";

import {
    isDevPathPluginEntry,
    isLocalPathPluginEntry,
    matchesPluginEntry,
} from "../adapters/opencode";
import { writeFileAtomic } from "../lib/atomic-write";
import { migrateConfigLocationsForCli } from "../lib/config-location-migration";
import { openExistingContextDatabase } from "../lib/database-access";
import { collectDiagnostics } from "../lib/diagnostics-opencode";
import {
    checkLocalEmbeddingRuntime,
    formatLocalEmbeddingRuntimeDoctorWarning,
    isLocalEmbeddingRuntimeBroken,
} from "../lib/embedding-runtime";
import { bundleIssueReport } from "../lib/logs-opencode";
import { detectOpenCodeInstallations } from "../lib/opencode-detect";
import {
    describeOpenCodeInstallations,
    type OpenCodeInstallationReport,
} from "../lib/opencode-helpers";
import {
    getOpenCodePluginCacheRoots,
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { detectConfigPaths, getMagicContextLogPath } from "../lib/paths";
import { confirm, intro, log, outro, selectOne, spinner, text } from "../lib/prompts";
import {
    sanitizeDiagnosticEndpoint,
    sanitizeDiagnosticText,
    sanitizePathString,
} from "../lib/redaction";
import { clearPluginCache } from "./doctor-opencode-cache";

const CLI_PACKAGE_NAME = "@ufoq/mini-magic-context";

export interface DoctorMigrationLogSink {
    success(message: string): void;
    warn(message: string): void;
}

export function migrateLegacyAgentEnabledConfigForDoctor(
    mcConfig: Record<string, unknown>,
    logs: DoctorMigrationLogSink,
): { changed: boolean; fixes: number } {
    let changed = false;
    let fixes = 0;

    const migrateLegacyAgentEnabled = (agentName: "dreamer" | "sidekick" | "historian"): void => {
        const agent = mcConfig[agentName] as Record<string, unknown> | undefined;
        if (!agent || typeof agent !== "object" || !("enabled" in agent)) return;

        const enabled = agent.enabled;
        const disable = agent.disable;
        delete agent.enabled;
        changed = true;
        fixes++;

        if (agentName === "historian") {
            logs.success(
                "Removed invalid historian.enabled (historian uses disable=true to turn off).",
            );
            return;
        }

        if (agentName === "dreamer") {
            if (disable !== true && enabled === false) {
                agent.disable = true;
                logs.warn(
                    "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
                );
            } else {
                logs.success(
                    'Removed deprecated dreamer.enabled (use dreamer.disable=true to turn off the Dreamer agent; use schedule="" for manual-only dreaming).',
                );
            }
            return;
        }

        if (disable !== true && enabled === false) {
            agent.disable = true;
            logs.success("Migrated sidekick.enabled=false → sidekick.disable=true.");
        } else {
            logs.success(
                "Removed deprecated sidekick.enabled (use sidekick.disable=true to turn off Sidekick).",
            );
        }
    };

    migrateLegacyAgentEnabled("dreamer");
    migrateLegacyAgentEnabled("sidekick");
    migrateLegacyAgentEnabled("historian");

    return { changed, fixes };
}

/**
 * Check whether the `review-user-memories` dreamer task is scheduled while the
 * dreamer itself is disabled, a no-op combination where candidate promotions
 * will never run. In v2, user-memory collection is gated by the task schedule
 * (non-empty = enabled), replacing the v1 `dreamer.user_memories` block.
 * Returns the warning message when the combination is wrong, or null otherwise.
 */
export function checkUserMemoriesDreamerCompatibility(
    mcConfig: Record<string, unknown>,
): string | null {
    const dreamerObj = mcConfig?.dreamer as Record<string, unknown> | undefined;
    if (dreamerObj?.disable !== true) return null;
    const tasksObj = dreamerObj.tasks as Record<string, unknown> | undefined;
    const reviewTask = tasksObj?.["review-user-memories"] as Record<string, unknown> | undefined;
    const schedule = reviewTask?.schedule;
    if (typeof schedule !== "string" || schedule.trim() === "") return null;
    return 'dreamer.tasks["review-user-memories"] is scheduled but dreamer.disable=true, so new promotions will not run. Remove dreamer.disable or set dreamer.tasks["review-user-memories"].schedule="" to disable the task.';
}

/**
 * Fetch the latest version of an npm package from the registry. Returns null
 * on any error so the doctor can report "check unavailable" rather than fail.
 */
async function fetchNpmLatest(pkg: string, timeoutMs = 5000): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
                signal: controller.signal,
                headers: { Accept: "application/json" },
            });
            if (!res.ok) return null;
            const body = (await res.json()) as { version?: unknown };
            return typeof body.version === "string" ? body.version : null;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return null;
    }
}

/** Self-version with src/dist layout fallback. */
function getSelfVersion(): string {
    const req = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
        } catch {
            // try next
        }
    }
    return "0.0.0";
}

export function isPinnedOpenCodePluginSpecifier(specifier: string): boolean {
    if (specifier === PLUGIN_NAME || specifier === PLUGIN_ENTRY_WITH_VERSION) return false;
    return specifier.startsWith(`${PLUGIN_NAME}@`);
}

export function getUserNpmrcPath(): string {
    const custom = process.env.NPM_CONFIG_USERCONFIG?.trim();
    if (custom) return custom;
    const home = process.env.HOME?.trim();
    return join(home || homedir(), ".npmrc");
}

export function collectNpmReleaseAgeWarnings(): string[] {
    const ageWarnings: string[] = [];
    const npmrcPath = getUserNpmrcPath();
    if (!existsSync(npmrcPath)) return ageWarnings;
    try {
        const npmrc = readFileSync(npmrcPath, "utf-8");
        for (const line of npmrc.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
            const [key] = trimmed.split("=").map((s) => s.trim());
            if (key === "min-release-age" || key === "before") {
                ageWarnings.push(
                    `${sanitizePathString(npmrcPath)} has '${sanitizeDiagnosticText(trimmed)}'`,
                );
            }
        }
    } catch {
        // Can't read .npmrc — skip.
    }
    return ageWarnings;
}

/** Compare semver-like strings. Returns -1 if a<b, 0 if equal, 1 if a>b. */
function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((s) => Number.parseInt(s, 10));
    const pb = b.split(/[.-]/).map((s) => Number.parseInt(s, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (Number.isNaN(x) || Number.isNaN(y)) return 0;
        if (x < y) return -1;
        if (x > y) return 1;
    }
    return 0;
}

// ── Issue flow ──────────────────────────────────────────────────────

function isGhInstalled(): boolean {
    try {
        execSync("gh --version", { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function openBrowser(url: string): void {
    try {
        if (process.platform === "darwin") {
            const child = spawnSync("open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "linux") {
            const child = spawnSync("xdg-open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "win32") {
            const child = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
            if (child.status === 0) return;
        }
    } catch {
        // Best-effort only.
    }
}

async function runIssueFlow(): Promise<number> {
    intro("Magic Context Issue Report");

    const title = await text("Issue title", {
        placeholder: "Short summary of the problem",
        validate: (value) => (value.trim() ? undefined : "Title is required"),
    });
    const description = await text("Issue description", {
        placeholder: "Describe what happened, what you expected, and repro steps",
        validate: (value) => (value.trim() ? undefined : "Description is required"),
    });

    const s = spinner();
    s.start("Collecting diagnostics");

    try {
        const report = await collectDiagnostics();
        s.stop("Diagnostics collected");

        // Ask the user which session this issue relates to. Only show the
        // picker when there's more than one recent session — otherwise the
        // single-session case is unambiguous, and the no-session case
        // (Node-only run without bun:sqlite) skips filtering entirely.
        let sessionFilter: string | null = null;
        if (report.recentSessions.length > 1) {
            const choice = await selectOne(
                "Which session is this issue about? (filters log lines from other sessions)",
                [
                    ...report.recentSessions.map((session, index) => {
                        const displayTitle = session.title.trim() || "(no title)";
                        const truncatedTitle =
                            displayTitle.length > 50
                                ? `${displayTitle.slice(0, 47)}...`
                                : displayTitle;
                        return {
                            label: `${truncatedTitle} — ${session.sessionId}${index === 0 ? " (most recent)" : ""}`,
                            value: session.sessionId,
                        };
                    }),
                    {
                        label: "All sessions (no filtering)",
                        value: "__all__",
                    },
                ],
            );
            sessionFilter = choice === "__all__" ? null : choice;
        }

        s.start("Bundling issue report");
        const bundled = await bundleIssueReport(report, description, title, sessionFilter);
        s.stop(`Report written to ${bundled.path}`);

        const shouldSubmit = await confirm("Submit this issue on GitHub now?", true);
        if (shouldSubmit && isGhInstalled()) {
            const result = spawnSync(
                "gh",
                [
                    "issue",
                    "create",
                    "-R",
                    "ufoq/mini-magic-context",
                    "--title",
                    title,
                    "--body-file",
                    bundled.path,
                ],
                { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
            );

            if (result.status === 0) {
                log.success(result.stdout.trim());
                outro("Issue submitted — thanks for the report!");
                return 0;
            }

            log.warn(result.stderr.trim() || "gh issue create failed");
        } else if (shouldSubmit && !isGhInstalled()) {
            log.warn("gh CLI not found — falling back to browser");
        }

        const url = `https://github.com/ufoq/mini-magic-context/issues/new?title=${encodeURIComponent(title)}&template=bug_report.yml`;
        log.info(
            `Open this URL and paste the contents of ${bundled.path} into the Diagnostics field:`,
        );
        log.info(url);
        openBrowser(url);
        outro("Issue report ready");
        return 0;
    } catch (error) {
        s.stop("Diagnostic collection failed");
        log.error(error instanceof Error ? error.message : String(error));
        outro("Issue report failed");
        return 1;
    }
}

// ── Embedding configuration check ───────────────────────────────────

/**
 * Validate the user's embedding configuration by probing the configured
 * endpoint. Runs only for `openai-compatible` providers — `local` needs no
 * network check and `off` degrades cleanly by design.
 *
 * Known footguns we surface specifically:
 *   - `{env:VAR}` in api_key when VAR is not exported → auth will fail with
 *     a literal `Bearer {env:VAR}` header.
 *   - Endpoint pointing at a specific route (e.g. `.../chat/completions`)
 *     rather than the provider base (e.g. `.../v1`) — gets detected by the
 *     real probe returning 404/405.
 *   - Provider that accepts the URL shape but doesn't implement embeddings
 *     (OpenRouter's /v1 for example) — same detection path.
 */
// Local embeddings need the native ONNX runtime (onnxruntime-node). On Windows
// it sometimes fails to install (its native binary download is interrupted), and
// the plugin's static `import "onnxruntime-node"` then throws on every embedding
// (#128). Surface it here with the fix instead of leaving users with the cryptic
// resolver error in the log. Shared by the explicit-`local` branch AND the
// no-config / default-provider path (local is the default, so a missing config
// still means local embeddings).
function checkLocalEmbeddingRuntimeForDoctor(): {
    issues: number;
    localRuntimeBroken?: boolean;
    unverified?: boolean;
} {
    const runtime = checkLocalEmbeddingRuntime(getOpenCodePluginCacheRoots());
    if (isLocalEmbeddingRuntimeBroken(runtime)) {
        log.warn(formatLocalEmbeddingRuntimeDoctorWarning(runtime));
        return { issues: 1, localRuntimeBroken: true };
    }
    if (runtime.state === "unknown") {
        log.warn(`Local embedding runtime unverified: ${runtime.reason}`);
        return { issues: 0, unverified: true };
    }
    log.success("Embedding provider: local (Xenova/all-MiniLM-L6-v2 bundled)");
    return { issues: 0 };
}

async function checkEmbeddingConfig(
    magicContextConfigPath: string,
): Promise<{ issues: number; localRuntimeBroken?: boolean; unverified?: boolean }> {
    if (!existsSync(magicContextConfigPath)) {
        // No config → local provider defaults apply. Still verify the local
        // runtime: local is the DEFAULT, so "no config" means local embeddings,
        // and a broken onnxruntime-node would silently fail (#128/#6).
        return checkLocalEmbeddingRuntimeForDoctor();
    }

    let rawText: string;
    try {
        rawText = readFileSync(magicContextConfigPath, "utf-8");
    } catch {
        log.warn("Could not read magic-context.jsonc for embedding check");
        return { issues: 1 };
    }

    // Substitute {env:} and {file:} before parsing so api_key / endpoint
    // reflect the values the runtime will actually see, and so we can report
    // unresolved tokens as concrete issues.
    const substituted = substituteConfigVariables({
        text: rawText,
        configPath: magicContextConfigPath,
    });

    let parsedConfig: Record<string, unknown>;
    try {
        parsedConfig = parse(substituted.text) as Record<string, unknown>;
    } catch (error) {
        log.warn(
            `Embedding check skipped — could not parse magic-context.jsonc: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { issues: 1 };
    }

    const embedding = parsedConfig?.embedding as Record<string, unknown> | undefined;
    const provider = embedding?.provider;

    if (provider === "off") {
        log.info("Embedding provider disabled — semantic memory search is off");
        return { issues: 0 };
    }

    if (provider === undefined || provider === "local") {
        return checkLocalEmbeddingRuntimeForDoctor();
    }

    if (provider !== "openai-compatible") {
        log.warn(
            `Unknown embedding provider: ${String(provider)} (expected local | openai-compatible | off)`,
        );
        return { issues: 1 };
    }

    const endpoint = typeof embedding?.endpoint === "string" ? embedding.endpoint.trim() : "";
    const model = typeof embedding?.model === "string" ? embedding.model.trim() : "";
    const apiKey = typeof embedding?.api_key === "string" ? embedding.api_key : undefined;
    const inputType =
        typeof embedding?.input_type === "string" ? embedding.input_type.trim() : undefined;
    const truncateMode =
        typeof embedding?.truncate === "string" ? embedding.truncate.trim() : undefined;

    let localIssues = 0;

    // Static configuration hygiene checks — raise before the network probe so
    // users get the specific guidance even when they're offline.
    if (!endpoint) {
        log.error("Embedding provider is openai-compatible but 'endpoint' is missing");
        return { issues: 1 };
    }
    if (!model) {
        log.error("Embedding provider is openai-compatible but 'model' is missing");
        return { issues: 1 };
    }

    // Flag unresolved {env:} residue — the substitution pass above would have
    // replaced resolved tokens, so any leftover {env: here means either the
    // env var was missing or the user wrote the literal text.
    if (apiKey && /\{env:[^}]+\}/.test(apiKey)) {
        log.warn(
            "api_key still contains {env:...} after substitution — the referenced environment variable is not set in this shell",
        );
        log.info(`  Raw value: ${apiKey}`);
        log.info(
            "  Export the variable before launching OpenCode (e.g. in ~/.zshrc, ~/.bashrc, or a shell profile)",
        );
        localIssues++;
    }

    // Surface any substitution warnings for the *user* config — we can't
    // tell which substitutions fed the embedding block specifically, but if
    // the block is broken and there are env-var warnings, they're almost
    // certainly related.
    if (substituted.warnings.length > 0) {
        for (const w of substituted.warnings.slice(0, 3)) {
            log.info(`  ${w}`);
        }
        if (substituted.warnings.length > 3) {
            log.info(`  ... and ${substituted.warnings.length - 3} more`);
        }
    }

    // Run the live probe.
    const probeSpinner = spinner();
    probeSpinner.start(
        `Testing embedding endpoint ${sanitizeDiagnosticEndpoint(endpoint)} (model: ${sanitizeDiagnosticText(model)})`,
    );

    let outcome: EmbeddingProbeOutcome;
    try {
        outcome = await probeEmbeddingEndpoint({
            endpoint,
            model,
            apiKey: apiKey,
            ...(inputType ? { inputType } : {}),
            ...(truncateMode ? { truncate: truncateMode } : {}),
            timeoutMs: 10_000,
        });
    } catch (error) {
        probeSpinner.stop("Embedding probe failed unexpectedly");
        log.error(
            `Probe threw: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}`,
        );
        return { issues: localIssues + 1 };
    }

    probeSpinner.stop("Embedding endpoint probed");

    switch (outcome.kind) {
        case "ok":
            log.success(
                `Embedding endpoint OK (${outcome.status}, ${outcome.dimensions ?? "?"}-dim vectors)`,
            );
            return { issues: localIssues };
        case "auth_failed":
            log.error(
                `Embedding endpoint rejected credentials (${outcome.status}) — check api_key / env var`,
            );
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            return { issues: localIssues + 1 };
        case "endpoint_unsupported":
            log.error(`Embedding endpoint does not support embeddings (${outcome.status})`);
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            log.info(
                "  Common causes: endpoint points at a chat-completion route (should be the provider base, e.g. '.../v1'), or the provider doesn't offer an embeddings API",
            );
            log.info(
                "  Known non-embedding providers: OpenRouter (chat proxy), Anthropic (no embeddings endpoint). Use OpenAI, Voyage, Together, or a local provider instead.",
            );
            return { issues: localIssues + 1 };
        case "http_error":
            log.error(`Embedding endpoint returned ${outcome.status}`);
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            return { issues: localIssues + 1 };
        case "timeout":
            log.warn(
                `Embedding endpoint did not respond within ${outcome.timeoutMs}ms — check endpoint URL and network`,
            );
            return { issues: localIssues + 1 };
        case "network_error":
            log.error(
                `Could not reach embedding endpoint: ${sanitizeDiagnosticText(outcome.message)}`,
            );
            return { issues: localIssues + 1 };
        case "invalid_scheme":
            log.error(
                `Embedding endpoint must start with http:// or https://: ${sanitizeDiagnosticEndpoint(outcome.endpoint)}`,
            );
            return { issues: localIssues + 1 };
    }
}

// ── Main doctor entry ───────────────────────────────────────────────

function logOpenCodeInstallationTable(installations: OpenCodeInstallationReport[]): void {
    log.info("OpenCode installations:");
    log.info("  marker   | path | version | source");
    for (const installation of installations) {
        log.info(
            `  ${installation.active ? "[active]" : "        "} | ${installation.path} | ${installation.version} | ${installation.source}`,
        );
    }
}

export async function runDoctor(
    options: { force?: boolean; issue?: boolean } = {},
): Promise<number> {
    migrateConfigLocationsForCli(process.cwd(), log);

    if (options.issue) {
        return runIssueFlow();
    }

    intro("Magic Context Doctor");

    let issues = 0;
    let fixed = 0;
    // Aligned with Pi doctor: emit a PASS/WARN/FAIL summary at the end so
    // results are scannable.
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;
    const pass = (msg: string) => {
        log.success(msg);
        passCount++;
    };
    const warn = (msg: string) => {
        log.warn(msg);
        warnCount++;
    };
    const fail = (msg: string) => {
        log.error(msg);
        failCount++;
        issues++;
    };

    // 1. Check OpenCode is installed. Keep every rung so a stale CLI cannot
    // hide a newer install that the user actually runs.
    const installationReports = describeOpenCodeInstallations(detectOpenCodeInstallations());
    const activeInstallation = installationReports[0];
    if (!activeInstallation) {
        fail("OpenCode is not installed or not in PATH");
        // Help users whose binary IS on PATH but is shadowed by a wrapper
        // script or lives in a directory not searched by our detection
        // (e.g. tool-version shims that only inject PATH at shell time).
        log.info("Doctor checked ~/.opencode/bin/opencode and each entry in $PATH.");
        log.info(
            "If `which opencode` succeeds outside doctor, your wrapper or shim may not be readable by Node — please share that wrapper in the issue.",
        );
        outro("Doctor failed — install OpenCode first");
        return 1;
    }
    if (installationReports.length > 1) {
        logOpenCodeInstallationTable(installationReports);
    }
    if (activeInstallation.kind === "desktop") {
        // Desktop ships no invocable CLI; the rest of doctor operates on config
        // and the plugin cache (both present for a Desktop install), so continue.
        pass(
            installationReports.length > 1
                ? "OpenCode Desktop selected for plugin checks (CLI not installed)"
                : "OpenCode Desktop detected (CLI not installed)",
        );
    } else if (activeInstallation.version === "unknown") {
        fail(`OpenCode CLI was found at ${activeInstallation.path} but could not be executed`);
    } else {
        pass(
            installationReports.length > 1
                ? `OpenCode ${activeInstallation.version} installed (active install marked above)`
                : `OpenCode ${activeInstallation.version} installed`,
        );
    }

    // 1b. CLI vs npm latest
    const selfVersion = getSelfVersion();
    const [npmLatest, pluginNpmLatest] = await Promise.all([
        fetchNpmLatest(CLI_PACKAGE_NAME),
        fetchNpmLatest(PLUGIN_NAME),
    ]);
    if (!npmLatest) {
        log.info(`Magic Context CLI v${selfVersion}; npm latest check unavailable`);
    } else if (compareVersions(selfVersion, npmLatest) < 0) {
        warn(`Magic Context CLI v${selfVersion} is older than npm latest v${npmLatest}`);
    } else {
        pass(`Magic Context CLI v${selfVersion} is current (npm latest v${npmLatest})`);
    }

    // 2. Check config paths exist
    const paths = detectConfigPaths();

    if (paths.opencodeConfigFormat === "none") {
        fail(`No opencode.json found at ${paths.opencodeConfig}`);
    } else {
        pass(`OpenCode config: ${paths.opencodeConfig}`);
    }

    // 3. Check magic-context.jsonc exists + parses + loads through schema
    if (existsSync(paths.magicContextConfig)) {
        pass(`Magic Context config: ${paths.magicContextConfig}`);
        // 3a. Validate JSONC parses (with config-variable substitution)
        try {
            const raw = readFileSync(paths.magicContextConfig, "utf-8");
            const substituted = substituteConfigVariables({
                text: raw,
                configPath: paths.magicContextConfig,
            }).text;
            parse(substituted);
            pass("magic-context.jsonc parses as valid JSONC");
        } catch (err) {
            fail(
                `magic-context.jsonc parse failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        // 3b. Validate config loads through plugin schema. loadPluginConfig
        // recovers from invalid leaf settings field-by-field and surfaces
        // soft warnings via configWarnings, so we can ask the schema to
        // load and report them without bailing on the doctor run.
        try {
            const result = loadPluginConfig(process.cwd());
            const warnings = result.configWarnings ?? [];
            if (warnings.length > 0) {
                warn(
                    `Magic Context config has ${warnings.length} warning(s) — see 'magic-context doctor --issue' for details`,
                );
            } else {
                pass("Magic Context config loads successfully");
            }
        } catch (err) {
            fail(
                `Could not load Magic Context config: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    } else {
        warn(`No magic-context.jsonc found — using defaults`);
        log.info("  Run 'setup' to create one with model recommendations");
    }

    // 4. Check plugin is in opencode.json
    if (paths.opencodeConfigFormat !== "none") {
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const config = parse(raw) as Record<string, unknown>;
            // Operate on the raw plugin array. Entries can be:
            //   • a string  "@ufoq/opencode-mini-magic-context@latest"
            //   • a tuple   ["@pkg/name@latest", { ...options }]
            //   • a dev URL "file:///abs/path/.../packages/plugin"
            // We MUST preserve every entry shape on write — filtering out
            // tuples (or stripping options) would silently drop user config.
            // matchesPluginEntry / isDevPathPluginEntry are imported from
            // ../adapters/opencode and accept both strings and tuples.
            const rawPlugins: unknown[] = Array.isArray(config?.plugin) ? config.plugin : [];
            const existingIdx = rawPlugins.findIndex(
                (entry) => matchesPluginEntry(entry, PLUGIN_NAME) || isDevPathPluginEntry(entry),
            );
            if (
                rawPlugins.some(
                    (entry) =>
                        isLocalPathPluginEntry(entry) &&
                        String(entry).includes("magic-context") &&
                        !isDevPathPluginEntry(entry),
                )
            ) {
                warn(
                    "An unverifiable local OpenCode plugin path was ignored because its package name is not Magic Context",
                );
            }
            const configName =
                paths.opencodeConfigFormat === "jsonc" ? "opencode.jsonc" : "opencode.json";

            // Helper: extract the plain string (or first element of a tuple) so
            // we can compare against the desired @latest entry.
            const entryAsString = (entry: unknown): string | null => {
                if (typeof entry === "string") return entry;
                if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
                return null;
            };

            if (
                existingIdx >= 0 &&
                entryAsString(rawPlugins[existingIdx]) === PLUGIN_ENTRY_WITH_VERSION
            ) {
                pass(`Plugin registered in ${configName}`);
            } else if (existingIdx >= 0) {
                const oldEntry = rawPlugins[existingIdx];
                const oldEntryStr = entryAsString(oldEntry) ?? "";

                // Dev-path entries (file://, absolute, relative) are detected
                // so we don't double-add @latest, but we MUST NOT replace them
                // — that would silently disable the developer's local plugin
                // checkout. Always log as-is and leave the entry alone, even
                // under --force.
                if (isDevPathPluginEntry(oldEntry)) {
                    pass(`Plugin registered in ${configName} (dev path: ${oldEntryStr})`);
                } else {
                    const isPinned = isPinnedOpenCodePluginSpecifier(oldEntryStr);

                    if (isPinned && !options.force) {
                        // Warn but don't change — user intentionally pinned
                        warn(
                            `Plugin pinned to ${oldEntryStr} in ${configName} — use 'doctor --force' to upgrade`,
                        );
                    } else {
                        // Upgrade versionless entry to @latest, or --force upgrades pinned.
                        // If the existing entry is a tuple, preserve options by
                        // updating only the package-name slot; otherwise replace
                        // with the plain string entry.
                        if (Array.isArray(oldEntry) && oldEntry.length >= 1) {
                            const replacement = [...oldEntry];
                            replacement[0] = PLUGIN_ENTRY_WITH_VERSION;
                            rawPlugins[existingIdx] = replacement;
                        } else {
                            rawPlugins[existingIdx] = PLUGIN_ENTRY_WITH_VERSION;
                        }
                        config.plugin = rawPlugins;
                        writeFileAtomic(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                        pass(
                            `Upgraded plugin entry in ${configName}: ${oldEntryStr} → ${PLUGIN_ENTRY_WITH_VERSION}`,
                        );
                        fixed++;
                    }
                }
            } else {
                // Auto-add plugin entry — preserves comments AND every existing
                // tuple/options entry the user already had.
                rawPlugins.push(PLUGIN_ENTRY_WITH_VERSION);
                config.plugin = rawPlugins;
                writeFileAtomic(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                pass(`Added plugin to ${configName}`);
                fixed++;
            }
        } catch {
            warn("Could not parse opencode config to verify plugin entry");
        }
    }

    // 5. Check for conflicts
    const cwd = process.cwd();
    const conflictResult = detectConflicts(cwd);

    if (conflictResult.hasConflict) {
        for (const reason of conflictResult.reasons) {
            fail(`Conflict: ${reason}`);
        }
        // Auto-fix conflicts
        const actions = fixConflicts(cwd, conflictResult.conflicts);
        for (const action of actions) {
            pass(`Fixed: ${action}`);
            fixed++;
        }
        if (actions.length > 0) {
            warn("Restart OpenCode for conflict fixes to take effect");
        }
    } else {
        pass("No conflicts detected (compaction, DCP, OMO hooks)");
    }

    // 7b. Validate embedding configuration — runs a real probe against the
    // configured endpoint so users catch misconfigured URL / missing env var /
    // wrong provider issues before relying on semantic memory search.
    const embeddingCheck = await checkEmbeddingConfig(paths.magicContextConfig);
    issues += embeddingCheck.issues;
    if (embeddingCheck.issues > 0) failCount += embeddingCheck.issues;
    else if (embeddingCheck.unverified) warnCount++;
    else passCount++;

    // 7c. Shared context DB exists, opens, integrity_check, row counts.
    // This catches corrupted DB files and misaligned storage paths early.
    const dbPath = join(getMagicContextStorageDir(), "context.db");
    if (!existsSync(dbPath)) {
        log.info(`Shared context DB not yet created at ${dbPath} (will be created on first run)`);
    } else {
        log.info(`Shared context DB exists at ${dbPath}`);
        try {
            // The schema compatibility check runs before integrity checks so a
            // newer schema can never be reported healthy by an older CLI.
            const db = openExistingContextDatabase(dbPath, { readonly: true });
            if (db === null) {
                throw new Error(`Shared context DB no longer exists at ${dbPath}`);
            }
            try {
                pass("Opened the shared DB with a supported schema");
                try {
                    const integrity = db.prepare("PRAGMA integrity_check").get() as
                        | { integrity_check?: string }
                        | undefined;
                    const result = integrity?.integrity_check ?? "unknown";
                    if (result === "ok") pass("SQLite integrity_check: ok");
                    else fail(`SQLite integrity_check reported: ${result}`);
                } catch (err) {
                    fail(
                        `SQLite integrity_check failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }

                // Row counts across the major tables — informational, not pass/fail.
                try {
                    const counts: Record<string, number> = {};
                    for (const table of ["tags", "compartments", "session_meta"]) {
                        try {
                            const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as
                                | { c?: number }
                                | undefined;
                            counts[table] = row?.c ?? 0;
                        } catch {
                            // Table may not exist on a brand-new DB before migrations run
                            counts[table] = 0;
                        }
                    }
                    const summary = Object.entries(counts)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ");
                    log.info(`Shared DB row counts: ${summary}`);
                } catch {
                    // Don't fail the doctor on row-count introspection issues
                }
            } finally {
                db.close();
            }
        } catch (err) {
            fail(`Could not open shared DB: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // 8. Check plugin npm cache — clear only if outdated
    const cacheResult = await clearPluginCache({
        force: options.force,
        latestVersion: pluginNpmLatest,
    });
    if (cacheResult.action === "cleared") {
        const versionInfo = cacheResult.cached
            ? ` (cached: ${cacheResult.cached}${cacheResult.latest ? `, latest: ${cacheResult.latest}` : ""})`
            : "";
        const reason = cacheResult.latest
            ? "outdated plugin cache"
            : "plugin cache (latest version check unavailable)";
        pass(`Cleared ${reason}${versionInfo} — latest will download on restart`);
        log.info(`  ${cacheResult.path}`);
        fixed++;
    } else if (cacheResult.action === "up_to_date") {
        pass(`Plugin cache up to date (v${cacheResult.cached})`);
    } else if (cacheResult.action === "check_unavailable") {
        warn(
            `Plugin cache version check unavailable; preserving cached plugin${cacheResult.cached ? ` (cached: ${cacheResult.cached})` : ""}. Use doctor --force to reinstall it.`,
        );
    } else if (cacheResult.action === "error") {
        warn(`Could not clear plugin cache: ${cacheResult.error}`);
        if (cacheResult.clearedPaths && cacheResult.clearedPaths.length > 0) {
            log.info(`  Cleared roots: ${cacheResult.clearedPaths.join(", ")}`);
        }
        if (cacheResult.failedPaths && cacheResult.failedPaths.length > 0) {
            log.info(`  Failed roots: ${cacheResult.failedPaths.join(", ")}`);
        } else {
            log.info(`  Manually delete: ${cacheResult.path}`);
        }
        issues++;
    } else {
        pass("Plugin cache clean (no cached version found)");
    }

    // 9. Check for min-release-age / before restrictions in ~/.npmrc.
    // OpenCode installs plugins with npm under the hood, so npm's age guards
    // apply. We don't check Bun's bunfig.toml anymore — the unified CLI uses
    // npx and the auto-update checker uses npm install, neither of which read
    // bunfig.
    {
        const ageWarnings = collectNpmReleaseAgeWarnings();

        if (ageWarnings.length > 0) {
            log.warn(
                "npm min-release-age restriction detected — this can prevent OpenCode from installing the latest plugin version",
            );
            for (const w of ageWarnings) {
                log.info(`  ${w}`);
            }
            log.info(
                "  If the plugin stays on an old version after doctor --force, this is the likely cause.",
            );
            log.info(
                "  Workaround: temporarily remove the restriction, restart OpenCode, then re-enable it.",
            );
            issues++;
        }
    }

    // 10. Show diagnostics info (log file, historian dumps)

    const logPath = getMagicContextLogPath("opencode");
    if (existsSync(logPath)) {
        const logStat = statSync(logPath);
        const sizeKb = (logStat.size / 1024).toFixed(0);
        log.info(`Log file: ${logPath} (${sizeKb} KB)`);
    } else {
        log.info(`Log file: ${logPath} (not yet created)`);
    }

    // Historian dumps live per-project under `<dir>/.cortexkit/mini-magic-context/historian/`.
    // We surface them grouped by project so users can see which session's dumps are
    // where. Falls back to the legacy tmp-dir layout when collectDiagnostics returns
    // empty buckets (Node-only runs, no OpenCode DB, no historian has run yet under
    // the new path).
    const diagnostics = await collectDiagnostics();
    const dumpBuckets = diagnostics.historianDumps.byProject;
    if (dumpBuckets.length > 0) {
        const totalCount = dumpBuckets.reduce((sum, b) => sum + b.count, 0);
        const sessionCount = dumpBuckets.length;
        warn(`Historian debug dumps: ${totalCount} file(s) across ${sessionCount} project(s)`);
        for (const bucket of dumpBuckets) {
            log.info(`  [${bucket.directory}] ${bucket.count} file(s)`);
            for (const dump of bucket.recent.slice(0, 3)) {
                const age = dump.ageMinutes;
                const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                log.info(`    ${dump.name} (${ageStr})`);
            }
            if (bucket.count > 3) {
                log.info(`    ... and ${bucket.count - 3} more`);
            }
        }
    }
    // Legacy tmp-dir dumps from pre-Phase 3 plugin versions — still listed if
    // present so users can find old artifacts without spelunking the tmp dir.
    const legacy = diagnostics.historianDumps.legacyDumps;
    if (legacy.count > 0) {
        log.info(`Legacy historian dumps (pre-v0.18.x): ${legacy.count} file(s) in ${legacy.dir}`);
    }

    // 11. Check OMO config
    if (paths.omoConfig) {
        log.info(`OMO config found: ${paths.omoConfig}`);
    }

    // Summary — aligned with Pi doctor format.
    console.log("");
    log.message(`Summary: PASS ${passCount} / WARN ${warnCount} / FAIL ${failCount}`);
    if (issues === 0 && fixed === 0) {
        outro("Everything looks good! ✨");
    } else if (issues > 0 && fixed > 0) {
        outro(`Found ${issues} issue(s), fixed ${fixed}. Restart OpenCode to apply.`);
    } else if (fixed > 0) {
        outro(`Fixed ${fixed} issue(s). Restart OpenCode to apply.`);
    } else {
        outro(`Found ${issues} issue(s) that need manual attention.`);
        return 1;
    }

    return 0;
}
