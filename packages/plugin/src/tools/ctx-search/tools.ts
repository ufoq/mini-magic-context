import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import { type UnifiedSearchResult, unifiedSearch } from "../../features/magic-context/search";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import {
    CTX_SEARCH_DESCRIPTION,
    CTX_SEARCH_TOOL_NAME,
    DEFAULT_CTX_SEARCH_LIMIT,
} from "./constants";
import type { CtxSearchArgs, CtxSearchSource, CtxSearchToolDeps } from "./types";

const VALID_SOURCES: ReadonlySet<CtxSearchSource> = new Set(["message"]);

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_CTX_SEARCH_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

/** Validate and normalize the `sources` arg. Drops unknown strings (the enum
 *  constraint catches them at the schema layer, but we still want a safe
 *  runtime check for plugins/tests that call this directly). Returns
 *  `undefined` only when the caller OMITTED `sources`; an explicit [] must stay
 *  [] so unifiedSearch honors the documented "no sources" meaning instead of
 *  widening back to "all sources". */
function normalizeSources(sources?: string[]): CtxSearchSource[] | undefined {
    if (sources === undefined) return ["message"];
    const result: CtxSearchSource[] = [];
    const seen = new Set<CtxSearchSource>();
    for (const source of sources) {
        if (VALID_SOURCES.has(source as CtxSearchSource)) {
            const typed = source as CtxSearchSource;
            if (!seen.has(typed)) {
                seen.add(typed);
                result.push(typed);
            }
        }
    }
    return result;
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
    if (results.some((result) => result.source === "message" || result.source === "compartment")) {
        bodyParts.push(
            "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.",
        );
    }
    const body = bodyParts.join("\n\n");
    return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${body}`;
}

const ctxSearchArgsShape = {
    query: tool.schema
        .string()
        .optional()
        .describe(
            "Search query. Matches against raw user/assistant message text and semantic historian compartments.",
        ),
    limit: tool.schema.number().optional().describe("Maximum results to return (default: 10)"),
    sources: tool.schema
        .array(tool.schema.enum(["message"]))
        .optional()
        .describe(
            "Optional. Restrict to message history. Omit for message history; pass [] to search no sources.",
        ),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxSearchArgsSchema = tool.schema.object(ctxSearchArgsShape).passthrough();

function createCtxSearchTool(deps: CtxSearchToolDeps): ToolDefinition {
    return tool({
        description: CTX_SEARCH_DESCRIPTION,
        args: ctxSearchArgsShape,
        async execute(rawArgs: CtxSearchArgs, toolContext) {
            const parsedArgs = ctxSearchArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxSearchArgs;
            args = unwrapImitatedReducedArgs(args, ["query"], {
                query: "string",
                limit: "number",
                sources: {
                    type: "array",
                    items: "string",
                    maxItems: 1,
                    values: ["message"],
                },
            });
            const query = args.query?.trim();
            if (!query) {
                return "Error: 'query' is required.";
            }

            // Only search message history up to the last compartment boundary —
            // anything after that (the live tail, including the current turn) is
            // still in context and already visible to the agent. When NO compartment
            // exists yet, the historian hasn't scrolled anything out of context, so
            // the boundary is 0: every indexed message (ordinals are 1-based) is in
            // the live tail and must be excluded. A negative sentinel here would mean
            // "search everything" and leak the current prompt back to the agent — the
            // exact opposite of the intent (issue #131).
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, toolContext.sessionID);
            const messageOrdinalCutoff = lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

            // Resolve the session's actual project from `toolContext.directory`
            // each call. OpenCode's top-level `ctx.directory` (the launch dir)
            // can differ from the session's working directory when the user
            // runs `opencode -s <id>` from outside the project.
            const projectPath = deps.resolveProjectPath(toolContext.directory);
            if (!projectPath) {
                return "Error: Could not resolve project identity for search.";
            }
            await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
            const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
            const embeddingEnabled = embeddingSnapshot
                ? embeddingSnapshot.enabled || embeddingSnapshot.gitCommitEnabled
                : deps.embeddingEnabled;

            const results = await unifiedSearch(
                deps.db,
                toolContext.sessionID,
                projectPath,
                query,
                {
                    limit: normalizeLimit(args.limit),
                    embeddingEnabled,
                    embedQuery: async (text, signal) => {
                        const result = await embedTextForProject(
                            projectPath,
                            text,
                            signal,
                            "query",
                        );
                        return result;
                    },
                    isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
                    maxMessageOrdinal: messageOrdinalCutoff,
                    sources: normalizeSources(args.sources),
                    // Explicit agent search → enable literal-probe multi-query
                    // recall for symbol/command/path lookups. Auto-search hints
                    // (the hot path) leave this off to protect their latency.
                    explicitSearch: true,
                },
            );

            return formatSearchResults(query, results, toolContext.sessionID);
        },
    });
}

export function createCtxSearchTools(deps: CtxSearchToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_SEARCH_TOOL_NAME]: createCtxSearchTool(deps),
    };
}
