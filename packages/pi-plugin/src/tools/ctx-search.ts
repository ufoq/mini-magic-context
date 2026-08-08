/**
 * Pi-side wrapper for the `ctx_search` tool.
 *
 * The core search logic in `unifiedSearch()` is harness-agnostic — it operates
 * over the shared SQLite store. The pi-plugin only needs to:
 *
 *   1. Translate the LLM-provided arguments into the search options shape.
 *   2. Resolve session ID and project identity from the Pi extension context.
 *   3. Format results for the LLM the same way the OpenCode plugin does.
 *
 * `ctx_expand` is now registered alongside (see `./ctx-expand.ts`) — Pi
 * sessions are JSONL files, but the shared `readSessionChunk` reads
 * via the `RawMessageProvider` registry, so Pi just registers its own
 * provider for the duration of an expand call.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type UnifiedSearchResult,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { CTX_SEARCH_DESCRIPTION } from "@magic-context/core/tools/ctx-search/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const DEFAULT_LIMIT = 10;
const ParamsSchema = Type.Object(
	{
		query: Type.Optional(
			Type.String({
				description:
					"Search query. Matches against raw user/assistant message text and semantic historian compartments.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum results to return (default: 10)",
			}),
		),
		sources: Type.Optional(
			Type.Array(Type.Literal("message"), {
				description:
					"Optional. Restrict to message history. Omit for message history; pass [] to search no sources.",
			}),
		),
	},
	{ additionalProperties: true },
);

type CtxSearchParams = Static<typeof ParamsSchema>;

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit))
		return DEFAULT_LIMIT;
	return Math.max(1, Math.floor(limit));
}

function formatResult(
	result: UnifiedSearchResult,
	index: number,
	_currentSessionId: string,
): string {
	if (result.source === "compartment") {
		return [
			`[${index}] [message] score=${result.score.toFixed(2)} compartment_id=${result.compartmentId} range=${result.startOrdinal}-${result.endOrdinal} match=${result.matchType} title=${result.title}`,
			result.snippet ? `Snippet: ${result.snippet}` : result.content,
		].join("\n");
	}

	const expandStart = Math.max(1, result.messageOrdinal - 3);
	const expandEnd = result.messageOrdinal + 3;
	return [
		`[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} range=${expandStart}-${expandEnd} role=${result.role}`,
		result.content,
	].join("\n");
}

function formatSearchResults(
	query: string,
	results: UnifiedSearchResult[],
	currentSessionId: string,
): string {
	if (results.length === 0) {
		return `No results found for "${query}" in compacted message history.`;
	}
	const bodyParts = results.map((result, index) =>
		formatResult(result, index + 1, currentSessionId),
	);
	if (
		results.some(
			(result) =>
				result.source === "message" || result.source === "compartment",
		)
	) {
		bodyParts.push(
			"Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.",
		);
	}
	const body = bodyParts.join("\n\n");
	return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${body}`;
}

export interface CtxSearchToolDeps {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	embeddingEnabled?: boolean;
}

export function createCtxSearchTool(
	deps: CtxSearchToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_search",
		label: "Magic Context: Search",
		description: CTX_SEARCH_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxSearchParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			params = unwrapImitatedReducedArgs(params, ["query"], {
				query: "string",
				limit: "number",
				sources: {
					type: "array",
					items: "string",
					maxItems: 1,
					values: ["message"],
				},
			});
			const query = params.query?.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "Error: 'query' is required." }],
					details: undefined,
					isError: true,
				};
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const projectIdentity = resolveProjectIdentityForSession(ctx.cwd);
			if (!projectIdentity) {
				return {
					content: [
						{
							type: "text",
							text: "Error: Could not resolve project identity for search.",
						},
					],
					details: undefined,
					isError: true,
				};
			}
			await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			const embeddingEnabled = snapshot
				? snapshot.enabled || snapshot.gitCommitEnabled
				: deps.embeddingEnabled;

			// Only search message history up to the last compartment boundary —
			// anything after that (the live tail, including the current turn) is
			// still in context and already visible to the agent. When NO compartment
			// exists yet, the historian hasn't scrolled anything out of context, so
			// the boundary is 0: every indexed message (ordinals are 1-based) is in
			// the live tail and must be excluded. A negative sentinel here would mean
			// "search everything" and leak the current prompt back to the agent — the
			// exact opposite of the intent (issue #131).
			const lastCompartmentEnd = getLastCompartmentEndMessage(
				deps.db,
				sessionId,
			);
			const messageOrdinalCutoff =
				lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

			const results = await unifiedSearch(
				deps.db,
				sessionId,
				projectIdentity,
				query,
				{
					limit: normalizeLimit(params.limit),
					embeddingEnabled,
					embedQuery: async (text, signal) => {
						const result = await embedTextForProject(
							projectIdentity,
							text,
							signal,
							"query",
						);
						return result;
					},
					isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
					maxMessageOrdinal: messageOrdinalCutoff,
					sources: params.sources ?? ["message"],
					// Explicit agent search → literal-probe multi-query recall
					// (parity with OpenCode's ctx_search). Pi auto-search leaves
					// this off to protect its latency budget.
					explicitSearch: true,
				},
			);

			return {
				content: [
					{
						type: "text",
						text: formatSearchResults(query, results, sessionId),
					},
				],
				details: undefined,
			};
		},
	};
}
