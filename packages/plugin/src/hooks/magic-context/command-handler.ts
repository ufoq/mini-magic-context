import { parseImportSourceArg } from "../../features/magic-context/slim-import";
import { getCompartments, getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { sessionLog } from "../../shared";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import {
    type PartialRecompRange,
    snapRangeToCompartments,
} from "./compartment-runner-partial-recomp";
import { executeFlush } from "./execute-flush";
import { executeStatus } from "./execute-status";
import type { NotificationParams } from "./send-session-notification";

interface RecompConfirmation {
    timestamp: number;
    argsKey: string;
}

const recompConfirmationBySession = new Map<string, RecompConfirmation>();
const RECOMP_CONFIRMATION_WINDOW_MS = 60_000;

const RECOMP_USAGE = [
    "Usage:",
    "- `/ctx-recomp` — full rebuild from message 1 to the protected tail",
    "- `/ctx-recomp <start>-<end>` — partial rebuild of a message range (e.g. `/ctx-recomp 1-11322`)",
    "- `/ctx-recomp --upgrade` — upgrade legacy v1 compartments to v2 layout",
].join("\n");

export function parseRecompArgs(
    raw: string,
):
    | { kind: "full" }
    | { kind: "partial"; range: PartialRecompRange }
    | { kind: "upgrade" }
    | { kind: "error"; message: string } {
    const trimmed = raw.trim();
    if (trimmed === "") return { kind: "full" };
    if (trimmed === "--upgrade") return { kind: "upgrade" };

    const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) {
        return {
            kind: "error",
            message: `Invalid /ctx-recomp arguments: \`${trimmed}\`.\n\n${RECOMP_USAGE}`,
        };
    }

    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return { kind: "error", message: "Range values must be finite integers." };
    }
    if (start < 1) return { kind: "error", message: `Start must be >= 1 (got ${start}).` };
    if (end < start)
        return { kind: "error", message: `End must be >= start (got ${start}-${end}).` };
    return { kind: "partial", range: { start, end } };
}

export function parseWrapupArgs(
    raw: string,
): { ok: true; messagesToKeep: number } | { ok: false; message: string } {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, messagesToKeep: 20 };
    if (!/^\d+$/.test(trimmed)) {
        return {
            ok: false,
            message:
                "Usage: `/ctx-wrapup [messages_to_keep]` where messages_to_keep is a positive integer.",
        };
    }
    const messagesToKeep = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep <= 0) {
        return { ok: false, message: "messages_to_keep must be a positive integer." };
    }
    return { ok: true, messagesToKeep };
}

export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}

export interface CommandExecuteOutput {
    parts: Array<{ type: string; text?: string }>;
}

const SENTINEL_PREFIX = "__CONTEXT_MANAGEMENT_";
const HTTP_SERVER_RESPONSE_TYPE_ID = "~effect/http/HttpServerResponse";
const HTTP_COOKIES_TYPE_ID = "~effect/http/Cookies";
const HTTP_BODY_TYPE_ID = "~effect/http/HttpBody";
const ERROR_REPORTER_IGNORE = "~effect/ErrorReporter/ignore";

function throwSentinel(command: string): never {
    const sentinel = new Error(`${SENTINEL_PREFIX}${command.toUpperCase()}_HANDLED__`) as Error &
        Record<string, unknown>;
    sentinel[HTTP_SERVER_RESPONSE_TYPE_ID] = HTTP_SERVER_RESPONSE_TYPE_ID;
    sentinel[ERROR_REPORTER_IGNORE] = true;
    sentinel.status = 204;
    sentinel.statusText = undefined;
    sentinel.headers = {};
    sentinel.cookies = { [HTTP_COOKIES_TYPE_ID]: HTTP_COOKIES_TYPE_ID, cookies: {} };
    sentinel.body = { [HTTP_BODY_TYPE_ID]: HTTP_BODY_TYPE_ID, _tag: "Empty" };
    throw sentinel;
}

function isSubagentSession(db: Database, sessionId: string): boolean {
    const meta = getOrCreateSessionMeta(db, sessionId);
    if (meta.isSubagent) return true;
    try {
        const row = db
            .prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { is_subagent?: unknown } | null;
        return row?.is_subagent === 1 || row?.is_subagent === true;
    } catch {
        return false;
    }
}

function getLegacyCompartmentCount(db: Database, sessionId: string): number {
    try {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1",
            )
            .get(sessionId) as { count?: number } | undefined;
        return typeof row?.count === "number" ? row.count : 0;
    } catch {
        return 0;
    }
}

function executeRecompUpgradeStub(db: Database, sessionId: string): string {
    const legacyCount = getLegacyCompartmentCount(db, sessionId);
    if (legacyCount === 0) {
        return "## Magic Recomp Upgrade\n\nNothing to upgrade: this session has no legacy compartments.";
    }
    return [
        "## Magic Recomp Upgrade",
        "",
        `Found ${legacyCount} legacy compartment${legacyCount === 1 ? "" : "s"} for this session.`,
        "Run `/ctx-recomp` without `--upgrade` to rebuild this session's compartments.",
    ].join("\n");
}

export function createMagicContextCommandHandler(deps: {
    db: Database;
    protectedTags: number | string[];
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
    historyBudgetPercentage?: number;
    commitClusterTrigger?: { enabled: boolean; min_clusters: number };
    getLiveModelKey?: (sessionId: string) => string | undefined;
    getContextLimit?: (sessionId: string) => number | undefined;
    onFlush?: (sessionId: string) => void;
    executeRecomp?: (
        sessionId: string,
        options?: { range?: PartialRecompRange },
    ) => Promise<string>;
    executeWrapup?: (sessionId: string, options: { messagesToKeep: number }) => Promise<string>;
    executeEmbedHistory?: (
        sessionId: string,
        options?: { signal?: AbortSignal; silent?: boolean },
    ) => Promise<string>;
    pauseEmbedDrain?: (sessionId: string) => string;
    getEmbedStatusText?: (sessionId: string) => string;
    executeImport?: (sessionId: string, sourceDbPath?: string) => Promise<string> | string;
    sendNotification: (
        sessionId: string,
        text: string,
        params: NotificationParams,
    ) => Promise<void>;
    toastDurationMs?: number;
    projectRoot?: string;
}) {
    const rawSendNotification = deps.sendNotification;
    deps.sendNotification = async (sessionId, text, params) => {
        try {
            await rawSendNotification(sessionId, text, params);
        } catch (err) {
            sessionLog(
                sessionId,
                `command notification delivery failed (continuing to sentinel): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    };

    return {
        "command.execute.before": async (
            input: CommandExecuteInput,
            _output: CommandExecuteOutput,
            _params: NotificationParams,
        ): Promise<void> => {
            const command = input.command;
            const handled = new Set([
                "mc-import-context",
                "ctx-status",
                "ctx-flush",
                "ctx-recomp",
                "ctx-wrapup",
                "ctx-embed",
            ]);
            if (!handled.has(command)) return;

            const sessionId = input.sessionID;
            let result = "";

            if (command === "mc-import-context") {
                result = deps.executeImport
                    ? await deps.executeImport(sessionId, parseImportSourceArg(input.arguments))
                    : "## Magic Context Import\n\nImport is unavailable in this runtime.";
            } else if (command === "ctx-embed") {
                const sub = input.arguments.trim().toLowerCase();
                if (sub === "pause") {
                    result = deps.pauseEmbedDrain
                        ? deps.pauseEmbedDrain(sessionId)
                        : "Embedding pause is unavailable.";
                } else if (sub === "start") {
                    result = deps.executeEmbedHistory
                        ? await deps.executeEmbedHistory(sessionId)
                        : "Semantic embedding is not configured for this project, so there is nothing to embed.";
                } else if (sub !== "") {
                    result =
                        "Usage: `/ctx-embed` (status), `/ctx-embed start`, or `/ctx-embed pause`.";
                } else if (isTuiConnected(sessionId)) {
                    pushNotification("action", { action: "show-embed-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-embed: pushed show-embed-dialog to TUI");
                    throwSentinel(command);
                } else {
                    result = deps.getEmbedStatusText
                        ? `## Embedding Status\n\n${deps.getEmbedStatusText(sessionId)}`
                        : "## Embedding Status\n\nEmbedding status is unavailable.";
                }
            } else if (command === "ctx-flush") {
                result = executeFlush(deps.db, sessionId);
                deps.onFlush?.(sessionId);
                if (isTuiConnected(sessionId)) {
                    pushNotification("action", { action: "show-flush-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-flush: pushed show-flush-dialog to TUI");
                    throwSentinel(command);
                }
            } else if (command === "ctx-status") {
                if (isTuiConnected(sessionId)) {
                    pushNotification("action", { action: "show-status-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-status: pushed show-status-dialog to TUI");
                    throwSentinel(command);
                }
                const liveModelKey = deps.getLiveModelKey?.(sessionId);
                result = executeStatus(
                    deps.db,
                    sessionId,
                    Array.isArray(deps.protectedTags)
                        ? deps.protectedTags.length
                        : deps.protectedTags,
                    deps.executeThresholdPercentage,
                    liveModelKey,
                    deps.historyBudgetPercentage,
                    deps.commitClusterTrigger,
                    deps.executeThresholdTokens,
                    deps.getContextLimit?.(sessionId),
                );
            } else if (command === "ctx-wrapup") {
                if (isSubagentSession(deps.db, sessionId)) {
                    result =
                        "## Magic Wrapup — Skipped\n\n/ctx-wrapup is only available in primary sessions.";
                } else {
                    const parsed = parseWrapupArgs(input.arguments);
                    if (!parsed.ok) {
                        result = `## Magic Wrapup\n\n${parsed.message}`;
                    } else if (!deps.executeWrapup) {
                        result =
                            "## Magic Wrapup\n\n/ctx-wrapup is unavailable because the historian handler is not configured.";
                    } else {
                        result = await deps.executeWrapup(sessionId, {
                            messagesToKeep: parsed.messagesToKeep,
                        });
                    }
                }
            } else if (command === "ctx-recomp") {
                const parsed = parseRecompArgs(input.arguments);
                if (parsed.kind === "error") {
                    result = `## Magic Recomp\n\n${parsed.message}`;
                } else if (parsed.kind === "upgrade") {
                    result = executeRecompUpgradeStub(deps.db, sessionId);
                } else if (!deps.executeRecomp) {
                    result =
                        "## Magic Recomp\n\nRecomp is unavailable because no historian model is configured.";
                } else if (parsed.kind === "partial") {
                    const snap = snapRangeToCompartments(
                        getCompartments(deps.db, sessionId),
                        parsed.range,
                    );
                    if ("error" in snap) {
                        result = `## Magic Recomp\n\n${snap.error}`;
                    } else {
                        result = await deps.executeRecomp(sessionId, {
                            range: { start: snap.snapStart, end: snap.snapEnd },
                        });
                    }
                } else {
                    const sessionCompartments = getCompartments(deps.db, sessionId);
                    if (sessionCompartments.length > 0 && !isTuiConnected(sessionId)) {
                        const argsKey = input.arguments.trim();
                        const now = Date.now();
                        const prev = recompConfirmationBySession.get(sessionId);
                        if (
                            !prev ||
                            prev.argsKey !== argsKey ||
                            now - prev.timestamp > RECOMP_CONFIRMATION_WINDOW_MS
                        ) {
                            recompConfirmationBySession.set(sessionId, { timestamp: now, argsKey });
                            result =
                                "## Magic Recomp\n\nThis will replace existing compartments. Run `/ctx-recomp` again within 60 seconds to confirm.";
                        } else {
                            recompConfirmationBySession.delete(sessionId);
                            result = await deps.executeRecomp(sessionId);
                        }
                    } else {
                        result = await deps.executeRecomp(sessionId);
                    }
                }
            }

            await deps.sendNotification(sessionId, result, {
                toastDurationMs: deps.toastDurationMs,
            });
            throwSentinel(command);
        },
    };
}
