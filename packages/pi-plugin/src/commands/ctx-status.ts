import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { executeStatus } from "@magic-context/core/hooks/magic-context/execute-status";
import { describeError } from "@magic-context/core/shared/error-message";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export interface RegisterCtxStatusDeps {
	db: ContextDatabase;
	projectIdentity: string;
	resolveStatusDeps?: (ctx: { cwd: string }) => CtxStatusRuntimeDeps;
	resolveProject?: (ctx: { cwd: string }) => {
		projectDir: string;
		projectIdentity: string;
	};
	protectedTags?: number;
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	historyBudgetPercentage?: number;
	injectionBudgetTokens?: number;
	commitClusterTrigger?: { enabled: boolean; min_clusters: number };
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
}

export type CtxStatusRuntimeDeps = Omit<
	RegisterCtxStatusDeps,
	"resolveStatusDeps"
>;

export interface CtxStatusDetails {
	sessionId: string;
	projectIdentity: string;
	activeTags: number;
	droppedTags: number;
	totalBytes: number;
	pendingOps: number;
	lastExecuteThreshold: number;
	compartmentCount: number;
	lastCompartmentRange: string | null;
	historian: {
		lastFireCount: number;
		inProgress: boolean;
		lastFailureAt: number | null;
		lastError: string | null;
		failureCount: number;
	};
}

export function registerCtxStatusCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxStatusDeps,
): void {
	pi.registerCommand("ctx-status", {
		description: "Show Magic Context status for the current Pi session",
		handler: async (_args, ctx) => {
			const runtimeDeps = deps.resolveStatusDeps?.(ctx) ?? deps;
			const projectIdentity =
				runtimeDeps.resolveProject?.(ctx).projectIdentity ??
				runtimeDeps.projectIdentity;
			const currentDeps = { ...runtimeDeps, projectIdentity };
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-status",
					text: "## Magic Status\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}

			try {
				const usage = ctx.getContextUsage?.();
				const modelKey = ctx.model
					? `${ctx.model.provider}/${ctx.model.id}`
					: undefined;
				const statusText = executeStatus(
					currentDeps.db,
					sessionId,
					currentDeps.protectedTags ?? 20,
					currentDeps.executeThresholdPercentage,
					modelKey,
					currentDeps.historyBudgetPercentage,
					currentDeps.commitClusterTrigger,
					currentDeps.executeThresholdTokens,
					usage?.contextWindow,
				);
				const details = buildStatusDetails(currentDeps, sessionId);
				sendCtxStatusMessage(
					pi,
					{ title: "/ctx-status", text: statusText, level: "info" },
					details,
				);
			} catch (error) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-status",
					text: `## Magic Status — Failed\n\n${describeError(error).brief}`,
					level: "error",
				});
			}
		},
	});
}

function buildStatusDetails(
	deps: RegisterCtxStatusDeps,
	sessionId: string,
): CtxStatusDetails {
	const meta = getOrCreateSessionMeta(deps.db, sessionId);
	const tags = getTagsBySession(deps.db, sessionId);
	const activeTags = tags.filter((tag) => tag.status === "active");
	const droppedTags = tags.filter((tag) => tag.status === "dropped");
	const compartments = getCompartments(deps.db, sessionId);
	const lastCompartment = compartments[compartments.length - 1];
	const totalBytes = activeTags.reduce((sum, tag) => sum + tag.byteSize, 0);

	return {
		sessionId,
		projectIdentity: deps.projectIdentity,
		activeTags: activeTags.length,
		droppedTags: droppedTags.length,
		totalBytes,
		pendingOps: getPendingOps(deps.db, sessionId).length,
		lastExecuteThreshold: meta.timesExecuteThresholdReached,
		compartmentCount: compartments.length,
		lastCompartmentRange: lastCompartment
			? `${lastCompartment.startMessage}-${lastCompartment.endMessage}`
			: null,
		historian: readHistorianState(deps.db, sessionId, meta),
	};
}

function readHistorianState(
	db: ContextDatabase,
	sessionId: string,
	meta: ReturnType<typeof getOrCreateSessionMeta>,
): CtxStatusDetails["historian"] {
	const row = db
		.prepare<
			[string],
			{
				historian_failure_count: number | null;
				historian_last_error: string | null;
				historian_last_failure_at: number | null;
			}
		>(
			"SELECT historian_failure_count, historian_last_error, historian_last_failure_at FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId);
	return {
		lastFireCount: meta.timesExecuteThresholdReached,
		inProgress: meta.compartmentInProgress,
		lastFailureAt:
			typeof row?.historian_last_failure_at === "number"
				? row.historian_last_failure_at
				: null,
		lastError: row?.historian_last_error ?? null,
		failureCount: row?.historian_failure_count ?? 0,
	};
}
