import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	HistorianConfig,
	MagicContextConfig,
} from "@ufoq/mini-magic-context-core/config/schema/magic-context";
import {
	type FailClosedReason,
	formatFailClosedBlockingMessage,
} from "@ufoq/mini-magic-context-core/features/magic-context/fail-closed-block";
import { resolveProjectIdentityForSession } from "@ufoq/mini-magic-context-core/features/magic-context/memory/project-identity";
import { scheduleIncrementalIndex } from "@ufoq/mini-magic-context-core/features/magic-context/message-index-async";
import { detectOverflow } from "@ufoq/mini-magic-context-core/features/magic-context/overflow-detection";
import type { ContextDatabase } from "@ufoq/mini-magic-context-core/features/magic-context/storage";
import {
	getOrCreateSessionMeta,
	getPendingPiCompactionMarkerState,
	getSessionsWithPendingPiMarker,
	updateSessionMeta,
} from "@ufoq/mini-magic-context-core/features/magic-context/storage";
import {
	applySqliteTuningPragmas,
	getSchemaFenceRejection,
	openDatabaseAsync,
	setSqlitePragmaConfig,
} from "@ufoq/mini-magic-context-core/features/magic-context/storage-db";
import {
	getOverflowState,
	recordOverflowDetected,
} from "@ufoq/mini-magic-context-core/features/magic-context/storage-meta-persisted";
import {
	deriveHistorianChunkTokens,
	resolveHistorianContextLimit,
} from "@ufoq/mini-magic-context-core/hooks/magic-context/derive-budgets";
import { resolveCacheTtl } from "@ufoq/mini-magic-context-core/hooks/magic-context/event-resolvers";
import { beginBootQuietPeriod } from "@ufoq/mini-magic-context-core/plugin/boot-quiet";
import {
	ANNOUNCEMENT_FEATURES,
	ANNOUNCEMENT_FOOTER,
	ANNOUNCEMENT_VERSION,
	markAnnouncementSeen,
	shouldShowAnnouncement,
} from "@ufoq/mini-magic-context-core/shared/announcement";
import { getMagicContextStorageDir } from "@ufoq/mini-magic-context-core/shared/data-path";
import { setHarness } from "@ufoq/mini-magic-context-core/shared/harness";
import { setKeepSubagents } from "@ufoq/mini-magic-context-core/shared/keep-subagents";
import { log } from "@ufoq/mini-magic-context-core/shared/logger";
import { isSaneLimit } from "@ufoq/mini-magic-context-core/shared/models-dev-cache";
import { resolveFallbackChain } from "@ufoq/mini-magic-context-core/shared/resolve-fallbacks";

import { handlePiCloneSessionStart } from "./clone-inheritance";
import {
	maybeAutoEmbedPiSession,
	registerCtxEmbedCommand,
} from "./commands/ctx-embed";
import { registerCtxFlushCommand } from "./commands/ctx-flush";
import { registerCtxRecompCommand } from "./commands/ctx-recomp";
import { registerCtxStatusCommand } from "./commands/ctx-status";
import { registerCtxWrapupCommand } from "./commands/ctx-wrapup";
import {
	registerCtxStatusEntryRenderer,
	sendCtxStatusMessage,
} from "./commands/pi-command-utils";
import { loadPiConfig } from "./config";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	clearPiM0Cache,
	clearSystemPromptRefresh,
	hasSystemPromptRefresh,
	type PiAutoSearchHandlerOptions,
	type PiContextHandlerOptions,
	type PiHistorianOptions,
	recordPiLiveModel,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
	trackSessionForProject,
} from "./context-handler";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { registerPiFailClosedSurface } from "./fail-closed-pi";
import { computePiPressure, extractAssistantUsage } from "./pi-pressure";
import { awaitInFlightRecomps } from "./pi-recomp-runner";
import { readPiSessionMessages } from "./read-session-pi";
import { registerStatusLine, updateStatusLine } from "./status-line";
import {
	configurePiSubagentExtensions,
	MAGIC_CONTEXT_PI_SUBAGENT_ENV,
	PiSubagentRunner,
} from "./subagent-runner";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import { withTimeout } from "./timeout";
import { registerMagicContextTools } from "./tools";

const PREFIX = "[magic-context][pi]";

// ---------------------------------------------------------------------------
// Process-global init latch (issue #247)
//
// `@gotgenes/pi-subagents` runs child agent sessions IN-PROCESS inside the
// parent Pi process. Each child inherits the parent's user packages, so Pi
// re-imports and re-runs this extension factory for every child session. The
// existing recursion guard (`MAGIC_CONTEXT_PI_SUBAGENT=1`) only covers
// SPAWNED subprocess children because in-process children share the parent's
// env without that variable. Without a process-wide signal, every in-process
// child re-ran the full Magic Context init — opening the DB, wiring timers /
// watchers / event handlers, and scheduling background session scans. Four
// parallel children fanned out concurrent `SessionManager.listAll` scans over
// ~392 JSONL sessions and crashed the parent with heap OOM.
//
// The latch below is a `Symbol.for` key on `globalThis` so it survives the
// duplicate module instances Pi's jiti loader creates per session
// (`moduleCache: false` resets module-level state on every re-import, but a
// Symbol.for key is process-global). The first init in this process sets it;
// every later init in the same process (in-process child, or a second factory
// call from any source) sees it set and no-ops with the SAME contract as a
// spawned subagent child — no watchers, no timers, no background scans. The
// parent's already-registered extension instance keeps serving its session.
//
// Dispose / re-arm: Pi fires `session_shutdown` (reason "reload") before a
// `/reload` re-imports extensions, and (reason "shutdown") when the user
// leaves the session. Each AgentSession owns its own ExtensionRunner, so a
// child session's `session_shutdown` only fires handlers the CHILD registered
// (none, because the child no-op'd) — it cannot clear the parent's latch.
// We clear the latch in the parent's `session_shutdown` handler so a `/reload`
// legitimately re-initializes, while ephemeral in-process children never touch
// it.
// ---------------------------------------------------------------------------
const PI_ACTIVE_LATCH = Symbol.for("magic-context.pi.active");

function isPiMagicContextActiveInProcess(): boolean {
	return (globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] === true;
}

function markPiMagicContextActive(): void {
	(globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] = true;
}

function clearPiMagicContextActive(): void {
	try {
		delete (globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH];
	} catch {
		// Some runtimes disallow delete on globalThis; fall back to overwrite.
		(globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] = undefined;
	}
}

function resolveCurrentProject(ctx: { cwd: string }): {
	projectDir: string;
	projectIdentity: string;
} {
	const projectDir = ctx.cwd;
	const projectIdentity = resolveProjectIdentityForSession(projectDir) ?? "";
	return { projectDir, projectIdentity };
}

export function signalPiDeferredCompactionMarkerDrain(sessionId: string): void {
	signalPiDeferredHistoryRefresh(sessionId);
	signalPiDeferredMaterialization(sessionId);
}

export function persistPiMessageEndModelMeta(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	cacheTtlConfig: MagicContextConfig["cache_ttl"];
}): void {
	if (!args.message || typeof args.message !== "object") return;
	const msg = args.message as {
		role?: string;
		provider?: string;
		model?: string;
	};
	if (
		msg.role !== "assistant" ||
		typeof msg.provider !== "string" ||
		msg.provider.length === 0 ||
		typeof msg.model !== "string" ||
		msg.model.length === 0
	) {
		return;
	}
	const modelKey = `${msg.provider}/${msg.model}`;
	recordPiLiveModel(args.sessionId, modelKey);
	const cacheTtl = resolveCacheTtl(args.cacheTtlConfig, modelKey);
	const currentMeta = getOrCreateSessionMeta(args.db, args.sessionId);
	if (currentMeta.cacheTtl !== cacheTtl) {
		updateSessionMeta(args.db, args.sessionId, { cacheTtl });
	}
}

function info(message: string, data?: unknown): void {
	log(`${PREFIX} ${message}`, data);
}

function warn(message: string, data?: unknown): void {
	log(`${PREFIX} WARN ${message}`, data);
}

// Memoized per directory so repeated /cd lookups do not spam the same config
// summary/warning lines on every hot-path config resolution.
const loggedPiConfigDirs = new Set<string>();
function logPiConfigLoad(args: {
	dir: string;
	loadedFromPaths: string[];
	warnings: string[];
	dedupe?: boolean;
}): void {
	const key = resolve(args.dir);
	if (args.dedupe && loggedPiConfigDirs.has(key)) return;
	if (args.dedupe) {
		loggedPiConfigDirs.add(key);
	}
	if (args.loadedFromPaths.length > 0) {
		info(`config loaded from: ${args.loadedFromPaths.join(", ")}`);
	} else {
		info("config: no magic-context.jsonc found, using schema defaults");
	}
	for (const warning of args.warnings) {
		warn(`config: ${warning}`);
	}
}

export const __test = {
	logPiConfigLoad,
	resetLoggedPiConfigDirs(): void {
		loggedPiConfigDirs.clear();
	},
	isPiMagicContextActiveInProcess,
	markPiMagicContextActive,
	clearPiMagicContextActive,
};

function formatTokens(value: number): string {
	return value.toLocaleString();
}

function getPiMessageModel(message: unknown): {
	provider: string | undefined;
	model: string | undefined;
} {
	if (!message || typeof message !== "object") {
		return { provider: undefined, model: undefined };
	}
	const msg = message as { provider?: unknown; model?: unknown };
	return {
		provider: typeof msg.provider === "string" ? msg.provider : undefined,
		model: typeof msg.model === "string" ? msg.model : undefined,
	};
}

function resolvePiPressureContextLimit(args: {
	db: ContextDatabase;
	sessionId: string;
	piContextWindow: number;
}): number {
	// Pi reports the model's context window directly (ctx.getContextUsage() /
	// ctx.getModel().contextWindow) — its own authoritative source. We no longer
	// consult models.dev for Pi. Sanity-bound the reported value so a transient
	// garbage window can't poison pressure (mirrors OpenCode's SDK sane bound).
	let effectiveContextLimit = isSaneLimit(args.piContextWindow)
		? args.piContextWindow
		: 0;
	try {
		const overflowState = getOverflowState(args.db, args.sessionId);
		if (overflowState.detectedContextLimit > 0) {
			effectiveContextLimit =
				effectiveContextLimit > 0
					? Math.min(effectiveContextLimit, overflowState.detectedContextLimit)
					: overflowState.detectedContextLimit;
		}
	} catch (err) {
		warn("message_end: getOverflowState failed:", err);
	}
	return effectiveContextLimit;
}

export async function persistPiPressureFromMessageEnd(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	piContextWindow: number;
	piTokens?: number;
	notifyIssue?: (message: string) => unknown | Promise<unknown>;
}): Promise<void> {
	const { provider, model } = getPiMessageModel(args.message);
	const effectiveContextLimit = resolvePiPressureContextLimit({
		db: args.db,
		sessionId: args.sessionId,
		piContextWindow: args.piContextWindow,
	});
	const usage = extractAssistantUsage(args.message);
	const pressure = computePiPressure(usage, effectiveContextLimit);
	const msg =
		args.message && typeof args.message === "object"
			? (args.message as { errorMessage?: unknown })
			: undefined;
	const messageHadOverflowError =
		typeof msg?.errorMessage === "string" &&
		detectOverflow(msg.errorMessage).isOverflow;
	const updates: Partial<{
		lastResponseTime: number;
		lastContextPercentage: number;
		lastInputTokens: number;
		observedSafeInputTokens: number;
		cacheAlertSent: boolean;
	}> = { lastResponseTime: Date.now() };

	if (pressure) {
		const percentage = pressure.percentage;
		const contextLimit = effectiveContextLimit;
		const meta = getOrCreateSessionMeta(args.db, args.sessionId);
		const observedSafeInputTokens = meta.observedSafeInputTokens ?? 0;
		if (
			percentage > 100 &&
			observedSafeInputTokens > 0 &&
			pressure.inputTokens <= observedSafeInputTokens * 2
		) {
			// Pi resolves the window from its own runtime, not a cache we could
			// reload — so a >100% reading with a known-good safe baseline means
			// Pi's reported contextWindow is genuinely wrong. There's nothing to
			// re-fetch; surface the alert (overflow detection still captures a
			// real lower cap separately).
			if (!meta.cacheAlertSent) {
				updates.cacheAlertSent = true;
				const safeTokens = Math.max(
					observedSafeInputTokens,
					pressure.inputTokens,
				);
				const modelLabel =
					provider && model ? `${provider}/${model}` : "the active model";
				await args.notifyIssue?.(
					`⚠️ Magic Context: Pi reports a context limit of ${formatTokens(contextLimit)} tokens for ${modelLabel} but you've successfully sent ${formatTokens(safeTokens)} tokens in this session — the reported limit looks wrong. Restart Pi if you suspect this is incorrect.`,
				);
			}
		}
		updates.lastContextPercentage = percentage;
		updates.lastInputTokens = pressure.inputTokens;
		if (!messageHadOverflowError) {
			updates.observedSafeInputTokens = Math.max(
				observedSafeInputTokens,
				pressure.inputTokens,
			);
		}
	} else if (typeof args.piTokens === "number") {
		updates.lastInputTokens = args.piTokens;
		if (args.piContextWindow > 0) {
			updates.lastContextPercentage =
				(args.piTokens / args.piContextWindow) * 100;
		}
	}

	updateSessionMeta(args.db, args.sessionId, updates);
}

/** Plugin version from package.json. */
const PLUGIN_VERSION: string = (() => {
	try {
		const req = createRequire(import.meta.url);
		return (req("../package.json") as { version: string }).version;
	} catch {
		return "0.0.0";
	}
})();

/** Assert the Pi-only host identity at module load. */
setHarness("pi");

// ---------------------------------------------------------------------------
// Config-driven resolvers
//
// `loadPiConfig()` reads the CortexKit project and user config paths. The
// resolvers below adapt the schema-shaped config into Pi-specific options.
//
// Each resolver returns `undefined` when the relevant feature is disabled
// in config, so the registration helpers can short-circuit cleanly.
// ---------------------------------------------------------------------------

export function resolveHistorianFromConfig(
	config: MagicContextConfig,
): PiHistorianOptions | undefined {
	// Defensive: schema declares `historian` required with default {}, but the
	// runtime config can come from a malformed JSONC merge that drops the
	// field. Fall back to undefined-safe access so plugin load never crashes.
	const historian = config.historian as HistorianConfig | undefined;
	if (historian?.disable === true) return undefined;
	const model = historian?.model?.trim();
	if (!model || model.length === 0) return undefined;

	// The historian chunk budget is anchored to the HISTORIAN model because
	// it bounds one summarizer call. The trigger budget is intentionally NOT
	// derived at startup: Pi resolves it per context pass from the live main
	// session model + effective execute threshold to match OpenCode.
	const historianContextLimit = resolveHistorianContextLimit(model);
	const historianChunkTokens = deriveHistorianChunkTokens(
		historianContextLimit,
	);

	const fallbackModels = resolveFallbackChain(historian?.fallback_models);

	return {
		runner: new PiSubagentRunner(),
		model,
		fallbackModels,
		historianChunkTokens,
		timeoutMs: config.historian_timeout_ms,
		// `historian.two_pass` runs an editor pass after a successful
		// first pass to clean low-signal U: lines and cross-compartment
		// duplicates. Mirrors OpenCode's config flag — defaults to false
		// on the schema side because the editor pass adds a second
		// historian round-trip's latency and token cost. Enable for
		// long sessions where chunk dedupe matters more than speed.
		twoPass: historian?.two_pass === true,
		// Pi only: explicit thinking level for historian subagent invocations.
		// When set, passed as --thinking <level> to Pi subprocess.
		// Required for providers like GitHub Copilot that apply bad defaults.
		thinkingLevel: historian?.thinking_level,
		executeThresholdPercentage: config.execute_threshold_percentage,
		executeThresholdTokens: config.execute_threshold_tokens,
		commitClusterTrigger: config.commit_cluster_trigger,
		protectedTags: config.protected_tags,
		clearReasoningAge: config.clear_reasoning_age,
		historyBudgetPercentage: config.history_budget_percentage,
		memoryEnabled: false,
		autoPromote: false,
		userMemoriesEnabled: false,
		language: config.language,
	};
}

function resolveAutoSearchFromConfig(
	config: MagicContextConfig,
): PiAutoSearchHandlerOptions {
	const auto = config.journal.auto_search;
	const enabled = auto?.enabled ?? false;
	return {
		enabled,
		scoreThreshold: auto?.score_threshold ?? 0.55,
		minPromptChars: auto?.min_prompt_chars ?? 20,
	};
}

export default async function (pi: ExtensionAPI): Promise<void> {
	if (process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] === "1") {
		log(
			`${PREFIX} subagent child detected (${MAGIC_CONTEXT_PI_SUBAGENT_ENV}=1); skipping full extension registration`,
		);
		return;
	}
	// In-process child guard (issue #247): `@gotgenes/pi-subagents` runs child
	// agent sessions in the SAME process as the parent. They share the parent's
	// env (so the spawned-child env guard above never fires) and re-trigger this
	// factory for every child session. The process-global latch marks that the
	// full Magic Context runtime is already active in this process; a second
	// init no-ops with the same contract as a spawned subagent (no watchers, no
	// timers, no background scans). The parent's registered instance keeps
	// serving. See the latch block above for the dispose / `/reload` re-arm path.
	if (isPiMagicContextActiveInProcess()) {
		log(
			`${PREFIX} in-process re-init detected (Magic Context already active in this process); skipping full extension registration`,
		);
		return;
	}
	markPiMagicContextActive();
	beginBootQuietPeriod();

	const storageDir = getMagicContextStorageDir();
	const dbPath = join(storageDir, "context.db");

	let db: ContextDatabase | null | undefined;
	let openFailureCause: string | null = null;
	try {
		db = await openDatabaseAsync();
	} catch (err) {
		openFailureCause = err instanceof Error ? err.message : String(err);
		db = null;
	}

	// openDatabase() returns null on the schema fence (DB newer than this binary).
	// Genuine storage-open exceptions are caught above. Either way Magic Context
	// cannot operate — when fail_closed_blocking is on (default), register a loud
	// blocking surface instead of silently skipping hooks (native compaction).
	if (!db) {
		const projectDirForConfig = process.cwd();
		const early = loadPiConfig({ cwd: projectDirForConfig });
		if (!early.config.enabled) {
			info(
				"plugin DISABLED via config (enabled: false) — skipping registration",
			);
			return;
		}
		const fence = getSchemaFenceRejection();
		const reason: FailClosedReason = fence
			? {
					kind: "schema_fence",
					persistedVersion: fence.persistedVersion,
					supportedVersion: fence.supportedVersion,
				}
			: {
					kind: "storage_failure",
					cause:
						openFailureCause ??
						`storage unavailable at ${dbPath} (cache schema newer than this binary, or open failed)`,
				};
		if (early.config.fail_closed_blocking === false) {
			warn(
				`Magic Context (pi) storage unavailable at ${dbPath}: ${formatFailClosedBlockingMessage(reason)}. ` +
					"fail_closed_blocking=false — degrading silently (hooks not registered).",
			);
			return;
		}
		warn(
			`Magic Context (pi) storage unavailable at ${dbPath}: ${formatFailClosedBlockingMessage(reason)}`,
		);
		let fullRuntimeStarted = false;
		registerPiFailClosedSurface(pi, {
			reason,
			tryReopen: async () => {
				try {
					return await openDatabaseAsync();
				} catch {
					return null;
				}
			},
			onRecovered: async (recoveredDb) => {
				if (fullRuntimeStarted) return;
				fullRuntimeStarted = true;
				await startPiMagicContextRuntime(pi, recoveredDb, dbPath);
			},
		});
		return;
	}

	await startPiMagicContextRuntime(pi, db, dbPath);
}

/**
 * Full Pi Magic Context registration after a successful storage open.
 * Extracted so a healed re-probe from the fail-closed surface can start the
 * runtime without requiring a process restart.
 */
async function startPiMagicContextRuntime(
	pi: ExtensionAPI,
	database: ContextDatabase,
	dbPath: string,
): Promise<void> {
	const db = database;

	// Capture boot project for initial config load and logging only. Runtime
	// identity/path resolution uses ctx.cwd per hook/command so session cwd
	// switches follow the active project without reloading config.
	const projectDir = process.cwd();
	const projectIdentity = resolveProjectIdentityForSession(projectDir) ?? "";

	try {
		const pendingPiMarkerSessions = getSessionsWithPendingPiMarker(db);
		for (const sid of pendingPiMarkerSessions) {
			signalPiDeferredCompactionMarkerDrain(sid);
		}
		if (pendingPiMarkerSessions.length > 0) {
			log(
				`${PREFIX} rehydrated ${pendingPiMarkerSessions.length} Pi deferred compaction marker session(s)`,
			);
		}
	} catch (err) {
		warn(
			`Magic Context (pi) failed to rehydrate deferred Pi compaction markers: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	info(
		`loaded v${PLUGIN_VERSION} | harness=pi | db=${dbPath} | ` +
			`project=${projectIdentity} | dir=${projectDir}`,
	);

	// Load the CortexKit project/user config and validate it with the shared
	// schema. Invalid fields are replaced by defaults and returned as warnings.
	//
	// We surface warnings via the standard `warn()` channel so users see
	// them in the magic-context log. Loading never throws — bad config
	// gracefully degrades to defaults.
	const { config, warnings, loadedFromPaths } = loadPiConfig({
		cwd: projectDir,
	});
	// The allowlist is user-tier only, so configure all child runners once at
	// boot. Project config is stripped before this merged config is returned.
	configurePiSubagentExtensions(config.pi?.subagent_extensions);
	logPiConfigLoad({
		dir: projectDir,
		loadedFromPaths,
		warnings,
		dedupe: true,
	});

	// Pi opens the shared DB before config is available (above), so apply the
	// configured SQLite tuning to the already-open connection now. cache_size /
	// mmap_size take effect live; future opens in this process pick them up via
	// setSqlitePragmaConfig.
	setSqlitePragmaConfig({
		cacheSizeMb: config.sqlite.cache_size_mb,
		mmapSizeMb: config.sqlite.mmap_size_mb,
	});
	applySqliteTuningPragmas(db);

	// Debug data-collection toggle: keep subagent child sessions instead of
	// deleting on success (parity with the OpenCode plugin).
	setKeepSubagents(config.keep_subagents === true);

	// Top-level disable: when `enabled: false` is set in config, register
	// nothing — same fail-closed posture the OpenCode plugin uses.
	if (!config.enabled) {
		info("plugin DISABLED via config (enabled: false) — skipping registration");
		return;
	}

	await ensureProjectRegisteredFromPiDirectory(projectDir, db);
	info(
		`registered embedding config for project ${projectIdentity ?? "(no project identity; cwd is $HOME)"}`,
	);

	type ResolvedPiProjectDeps = {
		projectDir: string;
		projectIdentity: string;
		config: MagicContextConfig;
		historianConfig: PiHistorianOptions | undefined;
		autoSearchConfig: PiAutoSearchHandlerOptions;
		contextOptions: PiContextHandlerOptions;
	};

	// Per-cwd runtime deps. Pi can switch projects mid-process (`/cd`,
	// multi-root), while tools and slash commands are registered only once.
	// Resolve all project-sensitive config through this memoized accessor so
	// every invocation reads the active cwd's config instead of the launch cwd's.
	const projectDepsByDir = new Map<string, ResolvedPiProjectDeps>();

	const buildContextOptions = (
		cfg: MagicContextConfig,
		hist: PiHistorianOptions | undefined,
		auto: PiAutoSearchHandlerOptions,
	): PiContextHandlerOptions => ({
		db: database,
		smartDrops: cfg.smart_drops === true,
		protectedTags: cfg.protected_tags ?? 20,
		heuristics: {
			caveman: cfg.caveman_text_compression
				? {
						enabled: cfg.caveman_text_compression.enabled,
						minChars: cfg.caveman_text_compression.min_chars,
					}
				: undefined,
			clearReasoningAge: cfg.clear_reasoning_age,
		},
		injection: {
			memoryEnabled: false,
			injectDocs: true,
			injectionBudgetTokens: 0,
			temporalAwareness: cfg.temporal_awareness === true,
		},
		scheduler: {
			executeThresholdPercentage: cfg.execute_threshold_percentage,
			executeThresholdTokens: cfg.execute_threshold_tokens,
		},
		historian: hist,
		language: cfg.language,
		autoSearch: auto,
		resolveForProject: resolveContextOptionsForProject,
		maybeAutoEmbedSession: (sessionId, dir, identity) => {
			maybeAutoEmbedPiSession(
				{
					db: database,
					projectDir: dir,
					projectIdentity: identity,
					memoryEnabled: false,
				},
				sessionId,
				dir,
				identity,
				(text) => {
					sendCtxStatusMessage(pi, {
						title: "/ctx-embed",
						text,
						level: "info",
					});
				},
			);
		},
	});

	function buildProjectDeps(
		dir: string,
		identity: string,
		cfg: MagicContextConfig,
	): ResolvedPiProjectDeps {
		const hist = resolveHistorianFromConfig(cfg);
		if (hist) {
			hist.onStatusChange = (ctx) => {
				updateStatusLine(ctx, {
					db: database,
					projectIdentity: resolveCurrentProject(ctx).projectIdentity ?? "",
				});
			};
		}
		const auto = resolveAutoSearchFromConfig(cfg);
		return {
			projectDir: dir,
			projectIdentity: identity,
			config: cfg,
			historianConfig: hist,
			autoSearchConfig: auto,
			contextOptions: buildContextOptions(cfg, hist, auto),
		};
	}

	function resolveProjectDepsForDir(
		dir: string,
		identityOverride?: string,
	): ResolvedPiProjectDeps {
		const cached = projectDepsByDir.get(dir);
		if (cached) return cached;
		const switchedLoad = loadPiConfig({ cwd: dir });
		logPiConfigLoad({
			dir,
			loadedFromPaths: switchedLoad.loadedFromPaths,
			warnings: switchedLoad.warnings,
			dedupe: true,
		});
		const switchedConfig = switchedLoad.config;
		const switchedIdentity =
			identityOverride ?? resolveProjectIdentityForSession(dir) ?? "";
		const built = buildProjectDeps(dir, switchedIdentity, switchedConfig);
		projectDepsByDir.set(dir, built);
		return built;
	}

	function resolveCurrentProjectDeps(ctx: {
		cwd: string;
	}): ResolvedPiProjectDeps {
		const currentProject = resolveCurrentProject(ctx);
		return resolveProjectDepsForDir(
			currentProject.projectDir,
			currentProject.projectIdentity,
		);
	}

	function resolveContextOptionsForProject(
		dir: string,
	): PiContextHandlerOptions {
		return resolveProjectDepsForDir(dir).contextOptions;
	}

	const bootProjectDeps = buildProjectDeps(projectDir, projectIdentity, config);
	projectDepsByDir.set(projectDir, bootProjectDeps);
	registerMagicContextTools(pi, {
		db,
		ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
	});
	info("registered tools: ctx_search, ctx_expand");

	pi.on("session_start", async (event, ctx) => {
		await handlePiCloneSessionStart(event, ctx, {
			db,
			signalPendingMarker: signalPiDeferredCompactionMarkerDrain,
		});
	});

	// Register the per-LLM-call transform pipeline. Tags eligible message
	// parts via the shared Tagger and applies queued drops from
	// `pending_ops` so /ctx-flush applies queued reclamation to Pi sessions.
	registerPiContextHandler(pi, bootProjectDeps.contextOptions);
	info(
		bootProjectDeps.historianConfig
			? `registered historian trigger (model=${bootProjectDeps.historianConfig.model}, executeThreshold=${formatExecuteThresholdForLog(bootProjectDeps.historianConfig.executeThresholdPercentage)})`
			: "registered historian trigger: DISABLED (set historian.model in magic-context.jsonc)",
	);
	info(
		bootProjectDeps.autoSearchConfig.enabled
			? `registered auto-search hint (threshold=${bootProjectDeps.autoSearchConfig.scoreThreshold}, minChars=${bootProjectDeps.autoSearchConfig.minPromptChars})`
			: "registered auto-search hint: DISABLED (journal.auto_search.enabled=false)",
	);

	// Register the shared renderer before any command can append a status entry.
	// Plain custom entries render in interactive Pi without entering model context.
	const statusEntryRendererAvailable = registerCtxStatusEntryRenderer(pi);
	info(
		statusEntryRendererAvailable
			? "registered model-invisible ctx-status entry renderer"
			: "ctx-status entry renderer unavailable; using legacy visible-message fallback",
	);

	// Step 5c: register the diagnostic/admin slash commands so Pi reaches
	// command-surface parity with the OpenCode plugin. Their user-facing output
	// uses model-invisible custom entries when the runtime can render them.
	const recompRunner = new PiSubagentRunner();
	const wrapupRunner = new PiSubagentRunner();
	registerCtxStatusCommand(pi, {
		db,
		projectIdentity,
		resolveProject: resolveCurrentProject,
		protectedTags: bootProjectDeps.config.protected_tags,
		executeThresholdPercentage:
			bootProjectDeps.config.execute_threshold_percentage,
		historyBudgetPercentage: bootProjectDeps.config.history_budget_percentage,
		injectionBudgetTokens: undefined,
		commitClusterTrigger: bootProjectDeps.config.commit_cluster_trigger,
		executeThresholdTokens: bootProjectDeps.config.execute_threshold_tokens,
		resolveStatusDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				projectIdentity: current.projectIdentity,
				resolveProject: resolveCurrentProject,
				protectedTags: current.config.protected_tags,
				executeThresholdPercentage: current.config.execute_threshold_percentage,
				historyBudgetPercentage: current.config.history_budget_percentage,
				injectionBudgetTokens: undefined,
				commitClusterTrigger: current.config.commit_cluster_trigger,
				executeThresholdTokens: current.config.execute_threshold_tokens,
			};
		},
	});
	info("registered /ctx-status");
	registerStatusLine(pi, { db, projectIdentity });
	info("registered magic-context status line");

	registerCtxFlushCommand(pi, { db });
	info("registered /ctx-flush");
	// /ctx-recomp uses its own PiSubagentRunner instance — recomp can run
	// concurrently with normal historian, and giving each its own runner
	// avoids cross-cancellation. Same model + fallback chain as historian.
	registerCtxRecompCommand(pi, {
		db,
		runner: recompRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: false,
		autoPromote: false,
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: recompRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: false,
				autoPromote: false,
			};
		},
	});
	info("registered /ctx-recomp");

	registerCtxWrapupCommand(pi, {
		db,
		runner: wrapupRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: false,
		autoPromote: false,
		userMemoriesEnabled: false,
		executeThresholdPercentage:
			bootProjectDeps.config.execute_threshold_percentage,
		executeThresholdTokens: bootProjectDeps.config.execute_threshold_tokens,
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: wrapupRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: false,
				autoPromote: false,
				userMemoriesEnabled: false,
				executeThresholdPercentage: current.config.execute_threshold_percentage,
				executeThresholdTokens: current.config.execute_threshold_tokens,
			};
		},
	});
	info("registered /ctx-wrapup");

	registerCtxEmbedCommand(pi, {
		db,
		projectDir,
		projectIdentity,
		memoryEnabled: true,
		resolveMemoryEnabled: () => true,
		resolveProject: resolveCurrentProject,
	});
	info("registered /ctx-embed");

	// Inject the magic-context guidance block into the system prompt for every agent
	// turn, then run hash-detection + sticky-date freezing so the
	// resulting prompt stays cache-stable across turns when nothing
	// material has changed.
	//
	// Pi has prefix caching the same way OpenCode does — every major
	// LLM provider (Anthropic, OpenAI, Codex, GitHub Copilot, etc.)
	// caches the system prompt portion of the prefix. Drift between
	// turns busts the cache and the user pays full input price for the
	// next call. The protections here mirror OpenCode's
	// `experimental.chat.system.transform` handler in
	// `system-prompt-hash.ts`.
	pi.on("before_agent_start", async (event, ctx) => {
		// Startup release announcement (Pi parity with OpenCode TUI dialog +
		// Desktop ignored message). Fires once per ANNOUNCEMENT_VERSION across
		// the whole machine — persistence file is shared with the OpenCode
		// plugin via `getMagicContextStorageDir()/last_announced_version`.
		//
		// Skipped silently when:
		//   - announcement constants are empty (bugfix-only release)
		//   - the current ANNOUNCEMENT_VERSION was already dismissed (here or
		//     in OpenCode TUI/Desktop)
		//   - ctx.hasUI is false (print/rpc subagent — no point notifying)
		//
		// Fire-and-forget: storage write happens inside markAnnouncementSeen,
		// any failure is swallowed. Worst case is a duplicate notification
		// the next time the user starts an interactive Pi session.
		try {
			if (ctx.hasUI && shouldShowAnnouncement()) {
				// URLs render as plain text. Modern terminals auto-detect and
				// let users Cmd-click; older terminals require manual copy.
				// We previously wrapped URLs in OSC 8 hyperlink escapes, but
				// not all terminals support them and `ctx.ui.notify` may also
				// re-render the message through pi-tui's text pipeline that
				// strips raw escapes. Plain text is the most reliable surface.
				const featureText = ANNOUNCEMENT_FEATURES.map(
					(line) => `  • ${line}`,
				).join("\n");
				const sections = [
					`✨ Magic Context v${ANNOUNCEMENT_VERSION} — what's new:`,
					"",
					featureText,
				];
				if (ANNOUNCEMENT_FOOTER && ANNOUNCEMENT_FOOTER.trim().length > 0) {
					// Blank-line separator distinguishes the persistent footer
					// (Discord invite, etc.) from the version-specific bullets.
					sections.push("", ANNOUNCEMENT_FOOTER);
				}
				ctx.ui.notify(sections.join("\n"), "info");
				markAnnouncementSeen(ANNOUNCEMENT_VERSION);
			}
		} catch {
			// Never block agent start on announcement delivery.
		}

		try {
			const effectiveProjectDeps = resolveCurrentProjectDeps(ctx);
			const currentProject = {
				projectDir: effectiveProjectDeps.projectDir,
				projectIdentity: effectiveProjectDeps.projectIdentity,
			};
			const effectiveConfig = effectiveProjectDeps.config;
			// Pi exposes `sessionManager.getSessionId()` once a session is
			// active. We resolve it here defensively because before_agent_start
			// fires once per agent turn.
			const sm = ctx.sessionManager;
			let sessionId: string | undefined;
			if (sm !== undefined) {
				const getId = (sm as { getSessionId?: () => string | undefined })
					.getSessionId;
				if (typeof getId === "function") {
					try {
						const id = getId.call(sm);
						if (typeof id === "string" && id.length > 0) sessionId = id;
					} catch {
						// Fail open — sessionId stays undefined.
					}
				}
			}
			if (sessionId) {
				trackSessionForProject(currentProject.projectIdentity, sessionId);

				// Re-arm a pending Pi compaction-marker drain on session ACTIVATION,
				// not just at process startup. session_before_switch clears the
				// in-memory deferred-refresh/materialization sets for the outgoing
				// session (those Sets are per-process and would otherwise leak); but
				// the durable pending marker in session_meta survives. On switch-BACK
				// the marker would then sit undrained (the drain is signal-driven, and
				// startup-only rehydration never re-fires). Re-signal here when this
				// session has a durable pending marker so the next eligible materializing
				// pass drains it, using the same deferred signal shape as startup.
				//
				// Gate on the same APIs the drain itself requires
				// (sessionManager.appendCompaction + getBranch): when they're
				// unavailable the drain skips-and-PRESERVES the signal, so re-signaling
				// every turn would keep an undrainable signal armed. Only re-arm when the
				// marker can actually be applied.
				try {
					const smForDrain = sm as {
						appendCompaction?: unknown;
						getBranch?: unknown;
					};
					const canDrain =
						typeof smForDrain.appendCompaction === "function" &&
						typeof smForDrain.getBranch === "function";
					if (canDrain && getPendingPiCompactionMarkerState(db, sessionId)) {
						signalPiDeferredCompactionMarkerDrain(sessionId);
					}
				} catch {
					// Best-effort: a read failure must not block agent start.
				}
			}

			// Use effectiveConfig (re-resolved from the CURRENT checkout's cwd on
			// a project switch) for every system-prompt decision below — a
			// switched-into project may carry its own .cortexkit/mini-magic-context.jsonc
			// (memory/docs/key-files/injection toggles). Reusing boot `config`
			// would render the launch project's adjuncts in the new checkout.
			if (effectiveConfig.system_prompt_injection?.enabled === false) {
				return;
			}
			const skipSigs =
				effectiveConfig.system_prompt_injection?.skip_signatures ?? [];
			if (
				skipSigs.some(
					(sig) => sig.length > 0 && event.systemPrompt.includes(sig),
				)
			) {
				return;
			}

			// PEEK the system-prompt refresh signal. Set by:
			//   - `/ctx-flush`
			//   - dreamer publication of new ARCHITECTURE.md / STRUCTURE.md
			//   - user-memory promotion (dreamer)
			//   - hash-change detection on the previous turn (signaled below)
			//
			// When set, we re-read disk-backed adjuncts on this turn. When
			// not set, cached values are reused.
			//
			// PEEK-then-drain-on-success (Oracle audit Round 8 #6): we
			// only `clearSystemPromptRefresh(...)` AFTER the rebuild
			// (`buildMagicContextBlock` + `processSystemPromptForCache`)
			// completes successfully. If either throws, the flag survives
			// so the next prompt retries the rebuild.
			const isCacheBusting = sessionId
				? hasSystemPromptRefresh(sessionId)
				: true; // first-pass-no-session: act as cache-busting (force fresh read)

			const block = buildMagicContextBlock({
				db,
				cwd: currentProject.projectDir,
				sessionId,
				memoryEnabled: false,
				includeGuidance: true,
				protectedTags: effectiveConfig.protected_tags,
				ctxReduceCallable: false,
				temporalAwarenessEnabled: effectiveConfig.temporal_awareness ?? false,
				cavemanTextCompressionEnabled:
					effectiveConfig.caveman_text_compression?.enabled === true,
				language: effectiveConfig.language,
				// Stable user memories rendered as <user-profile> — dreamer
				// promotes recurring observations into this set, then the
				// system prompt surfaces them across all sessions in the
				// project. Gated on dreamer.user_memories.enabled.
				userMemoriesEnabled: false,
				isCacheBusting,
				existingSystemPrompt: event.systemPrompt,
			});

			// Compose the final system prompt: base prompt from Pi + our
			// magic-context block. We always run hash detection on the
			// composed string so even sessions with no data block (e.g.
			// memories disabled, no docs, no key files) still get
			// sticky-date freezing and hash-change tracking.
			const composedPrompt = block
				? `${event.systemPrompt}\n\n${block}`
				: event.systemPrompt;

			if (!sessionId) {
				// No session id yet — return the composed prompt without
				// cache logic. The next turn (with a session id) will
				// compute the first hash and set sticky date.
				if (block) return { systemPrompt: composedPrompt };
				return;
			}

			const result = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: composedPrompt,
				isCacheBusting,
			});

			if (result.hashChanged) {
				// Real prompt-content change. Cache prefix is already
				// busted on this turn. Signal all three independent
				// refresh sets so the next pi.on("context") event
				// rebuilds <session-history> + lets queued ops
				// materialize, AND the next before_agent_start refreshes
				// adjuncts (since this turn's adjunct read used the
				// cached values that are now potentially stale).
				signalPiHistoryRefresh(sessionId);
				signalPiSystemPromptRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
			}

			// PEEK-then-drain-on-success (Oracle audit Round 8 #6):
			// drain only if the start-of-pass peek was true. Using the
			// CAPTURED boolean (not a re-read of the set) so that a
			// signal added later in the same pass — e.g. `result.hashChanged`
			// just above — survives to the next prompt for retry.
			if (isCacheBusting) {
				clearSystemPromptRefresh(sessionId);
			}

			return { systemPrompt: result.systemPrompt };
		} catch (error) {
			warn("failed to build magic-context block:", error);
			return;
		}
	});
	info("registered before_agent_start system prompt injector");

	// agent_end MUST be fire-and-forget for in-flight historian / dreamer
	// runs.
	//
	// REGRESSION FIXED HERE: Earlier code awaited `awaitInFlightHistorians()`
	// inside this handler with the (incorrect) assumption that Pi's event
	// fanout is synchronous and ignores returned Promises. In reality
	// pi-coding-agent's `extensions/runner.js` does `await handler(event, ctx)`
	// for every extension `agent_end` handler, and `agent-session.js`
	// awaits its own emit before delivering the UI-facing `agent_end`.
	// The TUI loader stops only after that UI event. Net effect: every
	// turn that triggered a historian (a 30s+ background subagent) left
	// the user staring at "Working..." with `historian` pinned in the
	// footer until the background run finished — the OPPOSITE of the
	// "compact in the background while the main agent keeps working"
	// invariant magic-context is supposed to provide.
	//
	// Why fire-and-forget is safe in interactive mode:
	//   - The Pi process stays alive between turns. The next turn's
	//     `pi.on("context")` handler checks `inFlightHistorian.has(sessionId)`
	//     and skips re-firing while a previous historian is still
	//     running, so we never double-spawn.
	//   - Historian publication paths register the run promise in
	//     `inFlightHistorian` so emergency 95% waits and `session_shutdown`
	//     drainage can still join the background work when actually
	//     needed.
	//   - All work historian does is durable (compartment + fact rows,
	//     publish marker, signalPiHistoryRefresh). Even if the user
	//     closes Pi mid-historian and the subprocess gets killed, the
	//     next session start re-evaluates and either picks up where the
	//     prior run left off or recovers from `historian_failure_count`.
	//
	// `pi --print` (single-turn, exits after agent_end) is the one mode
	// where backgrounding is genuinely incompatible with subprocess
	// lifetime — Pi's process exits and SIGKILLs the still-running
	// historian. That tradeoff is intentional: print mode is for
	// scripting / one-shot tasks where blocking the user's interactive
	// shell on a 30s historian is also wrong, just in a different way.
	// We let print mode skip the wait too. Users who want guaranteed
	// historian completion in print mode should run interactive Pi
	// instead.
	pi.on("agent_end", (_event, _ctx) => {
		// Synchronous return — DO NOT await background work here.
		// awaitInFlightHistorians()/awaitInFlightDreamers() are still
		// invoked at session_shutdown where they belong (and where pi
		// gives us a window before tearing down stdio). Errors from
		// background runs are handled by their own try/catch chains
		// (runPiHistorian wraps everything; spawnPiHistorianRun's
		// .finally cleans up the inFlight map).
		log("agent_end: returning synchronously (background work continues)");
	});

	// Cancel Pi's native context compaction. Magic Context owns the
	// compacted view of conversation history through its own historian
	// pipeline (compartments + facts + memories rendered as
	// `<session-history>` in `pi.on("context")`). If Pi's auto-compaction
	// were to run, it would:
	//   1. Pack the full conversation into a single plain-text user
	//      message and ask the LLM to summarize it. For sessions with a
	//      lot of accumulated history (especially after `doctor migrate`)
	//      that summarization request itself overflows the model's
	//      context window — the failure mode that surfaced as
	//      "Context overflow recovery failed" on migrated sessions.
	//   2. Replace history with that flat summary and lose the structured
	//      compartment / fact / memory state we depend on.
	//
	// Returning `{ cancel: true }` aborts both the threshold-driven
	// auto-compact and the post-overflow recovery compact. Pi treats
	// the abort as a no-op and proceeds with the unmodified branch on
	// the next turn — at which point our `pi.on("context")` transform
	// shrinks the prompt via tag drops, caveman compression, and
	// `<session-history>` injection over the much smaller live tail.
	//
	// Steady-state sessions normally don't hit this path because our
	// historian writes a Pi compaction marker at the boundary
	// (`sessionManager.appendCompaction()`), so `getBranch()` already
	// trims the prefix before Pi ever evaluates `shouldCompact`. The
	// hook is the safety net for everything else: migrated sessions
	// without a compaction marker, sessions where historian failed,
	// or any future flow where Pi's heuristic decides to compact.
	pi.on("session_before_compact", async (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			if (typeof sessionId === "string" && sessionId.length > 0) {
				clearPiM0Cache(db, sessionId, "session_before_compact");
			}
		} catch {
			// best-effort; still cancel Pi native compaction below
		}
		info("session_before_compact: cancelling — magic-context owns compaction");
		return { cancel: true };
	});

	pi.on("message_end", async (event, ctx) => {
		// Update last_response_time + last_input_tokens + last_context_percentage
		// so the scheduler's TTL gating can decide between execute and defer
		// on the next transform pass. Without this, every Pi pass would either
		// always execute (stale lastResponseTime=0 → TTL elapsed) or always
		// defer (no usage data) — neither matches OpenCode parity.
		try {
			const sm = ctx.sessionManager as
				| { getSessionId?: () => string | undefined }
				| undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			const endedMsg = event.message as unknown as {
				id?: string;
				role?: string;
			};
			if (
				endedMsg?.role === "assistant" &&
				typeof endedMsg.id === "string" &&
				endedMsg.id.length > 0
			) {
				const messageId = endedMsg.id;
				scheduleIncrementalIndex(db, sessionId, messageId, () => {
					const rawMessages = readPiSessionMessages(ctx);
					return (
						rawMessages.find((message) => message.id === messageId) ?? null
					);
				});
			}
			persistPiMessageEndModelMeta({
				db,
				sessionId,
				message: event.message,
				cacheTtlConfig: resolveCurrentProjectDeps(ctx).config.cache_ttl,
			});
			// Compute pressure with OpenCode-equivalent semantics: pull
			// the assistant's `usage` field and use
			// `input + cacheRead + cacheWrite` (NOT output) divided by
			// the effective context limit. The window comes from Pi's own
			// runtime — `getContextUsage().contextWindow`, falling back to
			// `ctx.model.contextWindow` if usage hasn't populated — NOT
			// models.dev. `session_meta.detected_context_limit` still overrides
			// it (in persistPiPressureFromMessageEnd) so post-overflow pressure
			// reflects the real, lower limit. See `pi-pressure.ts` for rationale.
			const piUsage = ctx.getContextUsage?.();
			const piContextWindow =
				piUsage &&
				typeof piUsage.contextWindow === "number" &&
				piUsage.contextWindow > 0
					? piUsage.contextWindow
					: (ctx.model?.contextWindow ?? 0);
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: event.message,
				piContextWindow,
				piTokens:
					piUsage && typeof piUsage.tokens === "number"
						? piUsage.tokens
						: undefined,
				notifyIssue: async (message) => {
					const uiNotify = (
						ctx as { ui?: { notify?: (message: string) => unknown } }
					).ui?.notify;
					if (typeof uiNotify === "function") {
						void uiNotify.call(ctx.ui, message);
					} else {
						warn(message);
					}
				},
			});
		} catch (err) {
			warn("message_end: persist session_meta usage failed:", err);
		}

		// Overflow recovery: if Pi's assistant message ended with a
		// provider context-overflow error (`message.errorMessage` matches
		// a known overflow pattern), record the recovery flag in
		// session_meta so the next transform pass treats this session as
		// "needs emergency recovery" — historian fires immediately, drop-
		// all-tools applies, and pressure math uses the real
		// detected_context_limit if the error reported one.
		//
		// Pi populates `errorMessage` on the assistant message when the
		// underlying API call fails (we saw exactly this pattern in the
		// Codex `context_length_exceeded` failure that motivated this
		// work). The provider-agnostic `detectOverflow` helper from
		// shared core matches Anthropic, OpenAI, Codex/OpenAI, xAI,
		// Cerebras, GitHub Copilot, OpenRouter, Ollama, vLLM, Mistral,
		// MiniMax, Kimi, Gemini, and a generic fallback.
		try {
			const sm = ctx.sessionManager as
				| { getSessionId?: () => string | undefined }
				| undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			const msgRaw = event.message as unknown;
			if (!msgRaw || typeof msgRaw !== "object") return;
			const msg = msgRaw as {
				role?: string;
				errorMessage?: string;
				provider?: string;
				model?: string;
			};
			if (msg.role !== "assistant") return;
			if (
				typeof msg.errorMessage !== "string" ||
				msg.errorMessage.length === 0
			) {
				return;
			}
			const detection = detectOverflow(msg.errorMessage);
			if (!detection.isOverflow) return;
			const modelKey =
				typeof msg.provider === "string" &&
				typeof msg.model === "string" &&
				msg.provider.length > 0 &&
				msg.model.length > 0
					? `${msg.provider}/${msg.model}`
					: undefined;
			recordOverflowDetected(db, sessionId, detection.reportedLimit, modelKey);
			log(
				`[magic-context][${sessionId}] overflow detected: reportedLimit=${
					detection.reportedLimit ?? "?"
				} pattern=${detection.matchedPattern ?? "?"}`,
			);
		} catch (err) {
			warn("message_end: overflow detection failed:", err);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Bounded drain of in-flight historian / dreamer runs that were
		// kicked off by recent turns. We moved the drain here from
		// `agent_end` because Pi awaits agent_end handlers and was
		// stalling the UI loader on every turn that triggered historian.
		// session_shutdown only fires when the user is actually leaving
		// the session, so a brief wait is acceptable — and lets the
		// JSONL session state reach a consistent compartment boundary
		// before the process exits.
		//
		// 5-second cap protects interactive shutdown from a hung
		// subagent. In `pi --print` mode the process exits after
		// agent_end before this handler fires anyway, so the cap
		// doesn't help that mode (and we don't pretend it does — see
		// the comment block on the agent_end handler above).
		const SHUTDOWN_DRAIN_MS = 5_000;
		try {
			await withTimeout(awaitInFlightHistorians(), SHUTDOWN_DRAIN_MS);
		} catch (err) {
			warn("shutdown: historian drain threw:", err);
		}
		try {
			await withTimeout(awaitInFlightRecomps(), SHUTDOWN_DRAIN_MS);
		} catch (err) {
			warn("shutdown: recomp drain threw:", err);
		}
		// Clear per-session system-prompt adjunct caches (sticky date,
		// project docs, user profile, key files). Pi's
		// `_extensionRunner.invalidate` resets module state on session
		// swap, but on plain shutdown the maps would otherwise hold
		// their last entries. Best-effort: if sessionId can't be
		// resolved we just skip — Pi resets module state on /reload
		// anyway.
		try {
			const sm = (
				ctx as unknown as {
					sessionManager?: { getSessionId?: () => string | undefined };
				}
			).sessionManager;
			const sessionId =
				typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
			if (typeof sessionId === "string" && sessionId.length > 0) {
				clearPiSystemPromptSession(sessionId);
				// Drain context-handler session-keyed maps too. Without
				// this, sessions accumulate state across `session_shutdown`
				// in long-lived Pi processes that re-init the extension.
				clearContextHandlerSession(sessionId);
			}
		} catch {
			// best-effort cleanup
		}
		// Re-arm the process-global init latch (issue #247). Pi fires
		// `session_shutdown` (reason "reload") before a `/reload` re-imports
		// extensions, and (reason "shutdown") when the user leaves the
		// session. Each AgentSession owns its own ExtensionRunner, so an
		// in-process child's `session_shutdown` only fires handlers the
		// CHILD registered — and a child that no-op'd via the latch
		// registered none, so it cannot clear the parent's latch. Clearing
		// here lets a `/reload` legitimately re-initialize the full runtime,
		// while ephemeral in-process children never touch it.
		clearPiMagicContextActive();
	});

	// Pi has no `session_deleted` event, but `session_before_switch`
	// fires when the user switches to a different session within the
	// same Pi process. That's the right moment to drain caches keyed
	// by the OUTGOING session id — without this, every session swap
	// in a long-running Pi process leaks one entry per cache, and
	// after dozens of swaps the maps balloon. Cleanup here mirrors
	// OpenCode's `session.deleted` handler in `event-handler.ts`.
	pi.on("session_before_switch", (_event, ctx) => {
		try {
			const sm = (
				ctx as unknown as {
					sessionManager?: { getSessionId?: () => string | undefined };
				}
			).sessionManager;
			const outgoingSessionId =
				typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
			if (
				typeof outgoingSessionId === "string" &&
				outgoingSessionId.length > 0
			) {
				// Clear ONLY the in-memory per-session maps (the actual leak that
				// grows one entry per swap). Do NOT clear the durable DB m[0] cache
				// here: session_before_switch is REVERSIBLE (the user can switch
				// back), unlike OpenCode's session.deleted. The DB cache is bounded
				// (one session_meta row per session) and self-invalidates via
				// epoch/version/docs-hash checks in mustMaterializePi, so preserving
				// it lets a switch-back reuse the cached prefix instead of forcing a
				// full m[0] re-materialization (an avoidable prompt-cache bust).
				clearPiSystemPromptSession(outgoingSessionId);
				clearContextHandlerSession(outgoingSessionId);
			}
		} catch {
			// best-effort — Pi proceeds with the switch regardless
		}
	});
}

/**
 * Format `execute_threshold_percentage` for the boot log. The config accepts
 * either a bare number or a per-model map (`{ default: 65, "provider/model": 50 }`);
 * naive interpolation printed the map form as `[object Object]%`.
 */
function formatExecuteThresholdForLog(
	value: number | { default: number; [modelKey: string]: number } | undefined,
): string {
	if (value === undefined) return "65%";
	if (typeof value === "number") return `${value}%`;
	const overrides = Object.entries(value)
		.filter(([key]) => key !== "default")
		.map(([key, pct]) => `${key}=${pct}%`);
	const base = `${value.default}%`;
	return overrides.length > 0 ? `${base} (${overrides.join(", ")})` : base;
}
