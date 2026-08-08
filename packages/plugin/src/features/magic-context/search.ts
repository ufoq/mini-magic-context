import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    loadCompartmentChunkEmbeddingsForSearch,
    type StoredCompartmentChunkEmbedding,
} from "./compartment-chunk-embedding";
import { containsProbeVerbatim, extractLiteralProbes } from "./literal-probes";
import { cosineSimilarity } from "./memory/cosine-similarity";
import { getIndexedMessageCorpusSize } from "./message-index";

const DEFAULT_UNIFIED_SEARCH_LIMIT = 10;
const SINGLE_SOURCE_PENALTY = 0.8;
const RESULT_PREVIEW_LIMIT = 220;
/**
 * Source boost multipliers for unified ranking.
 *
 * The journal lane has exactly two sources: messages (raw history that survived
 * compression) and compartments (historian summaries). Messages carry the
 * specific details the historian didn't preserve, so they sit slightly above
 * baseline.
 */
const MESSAGE_SOURCE_BOOST = 1.15;

interface MessageSearchRow {
    messageOrdinal?: number | string;
    messageId?: string;
    role?: string;
    content?: string;
}

interface BatchedMessageSearchRow extends MessageSearchRow {
    queryIndex?: number;
    ftsRank?: number;
}

interface BatchedFtsCountRow {
    queryIndex?: number;
    count?: number;
}

const messageSearchStatements = new WeakMap<Database, PreparedStatement>();
const messageSearchStatementsWithCutoff = new WeakMap<Database, PreparedStatement>();
const batchedMessageSearchStatements = new WeakMap<Database, Map<string, PreparedStatement>>();
const batchedFtsCountStatements = new WeakMap<Database, Map<string, PreparedStatement>>();

export type SearchSource = "message";

export interface CapturedQueryEmbedding {
    vector: Float32Array;
    modelId: string;
    chunkModelId: string;
    generation: number;
}

export interface UnifiedSearchOptions {
    limit?: number;
    embeddingEnabled?: boolean;
    /** Deprecated: message search no longer reads raw messages on the hot path. */
    readMessages?: (sessionId: string) => unknown[];
    /** Query embedder injected by the caller. When omitted, semantic compartment
     *  search is skipped (message FTS still runs). Search.ts deliberately does
     *  NOT import the embedding registry, which transitively pulls removed
     *  memory/git storage into the bundle. */
    embedQuery?: (
        text: string,
        signal?: AbortSignal,
    ) => Promise<CapturedQueryEmbedding | Float32Array | null>;
    isEmbeddingRuntimeEnabled?: () => boolean;
    /** Only return message-history hits with ordinal ≤ this value (e.g. last compartment end). -1 or omit to search all. */
    maxMessageOrdinal?: number;
    /** Restrict results to these sources. Omit or pass undefined to search message history (the only source). */
    sources?: SearchSource[];
    /** Abort signal — cancels in-flight embedding requests when the caller gives up. */
    signal?: AbortSignal;
    /** When true, run multi-probe message search: extract literal symbol/command/
     *  path probes from the query and query each one separately (RRF-fused). Default
     *  false — only explicit `ctx_search` tool calls opt in; auto-search stays
     *  single-probe to protect its latency budget. */
    explicitSearch?: boolean;
    embeddingModelIdOverride?: string;
    chunkModelIdOverride?: string;
}

export interface MessageSearchResult {
    source: "message";
    content: string;
    score: number;
    messageOrdinal: number;
    messageId: string;
    role: string;
}

export interface CompartmentSearchResult {
    source: "compartment";
    content: string;
    score: number;
    compartmentId: number;
    sessionId: string;
    title: string;
    startOrdinal: number;
    endOrdinal: number;
    matchType: "semantic" | "hybrid";
    snippet?: string;
}

export type UnifiedSearchResult = MessageSearchResult | CompartmentSearchResult;

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_UNIFIED_SEARCH_LIMIT;
    }
    return Math.max(1, Math.floor(limit));
}

function normalizeCosineScore(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }

    return Math.min(1, Math.max(0, score));
}

function previewText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= RESULT_PREVIEW_LIMIT) {
        return normalized;
    }
    return `${normalized.slice(0, RESULT_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 *
 * FTS5 interprets characters like `-`, `:`, `*`, `(`, `)` as operators. This
 * wraps each whitespace-delimited token in double quotes so special characters
 * are treated as literal content rather than query syntax. Copied here from the
 * removed memory FTS module so the journal lane doesn't import memory storage.
 */
function sanitizeFtsQuery(query: string): string {
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) return "";

    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

function getMessageSearchStatement(db: Database): PreparedStatement {
    let stmt = messageSearchStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?",
        );
        messageSearchStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Cutoff-aware variant: filters `message_ordinal <= cutoff` IN SQL, BEFORE the
 * LIMIT. The JS-side post-filter in runMessageFtsQuery applies the cutoff AFTER
 * fetching `LIMIT` rows, so when the top-ranked rows are all live-tail (above the
 * cutoff) they're fetched-then-discarded and older eligible hits below the limit
 * are never seen — explicit ctx_search could then return nothing. Pushing the
 * predicate into SQL makes LIMIT count only already-eligible rows.
 */
function getMessageSearchStatementWithCutoff(db: Database): PreparedStatement {
    let stmt = messageSearchStatementsWithCutoff.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? AND CAST(message_ordinal AS INTEGER) <= ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?",
        );
        messageSearchStatementsWithCutoff.set(db, stmt);
    }
    return stmt;
}

function getBatchedFtsCountStatement(
    db: Database,
    queryCount: number,
    cutoff: number | null,
): PreparedStatement {
    let statements = batchedFtsCountStatements.get(db);
    if (!statements) {
        statements = new Map();
        batchedFtsCountStatements.set(db, statements);
    }
    const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}`;
    let statement = statements.get(key);
    if (!statement) {
        const cutoffSql = cutoff === null ? "" : " AND CAST(message_ordinal AS INTEGER) <= ?";
        statement = db.prepare(
            Array.from(
                { length: queryCount },
                (_, index) =>
                    `SELECT ${index} AS queryIndex, COUNT(*) AS count
                       FROM message_history_fts
                      WHERE session_id = ? AND message_history_fts MATCH ?${cutoffSql}`,
            ).join("\nUNION ALL\n"),
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Read all per-probe document frequencies in one SQLite statement. */
function countSessionFtsMatchesBatch(
    db: Database,
    sessionId: string,
    ftsQueries: readonly string[],
    cutoff: number | null,
): number[] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        bindings.push(sessionId, query);
        if (cutoff !== null) bindings.push(cutoff);
    }
    try {
        const rows = getBatchedFtsCountStatement(db, ftsQueries.length, cutoff).all(
            ...bindings,
        ) as BatchedFtsCountRow[];
        const counts = Array.from({ length: ftsQueries.length }, () => 0);
        for (const row of rows) {
            if (
                typeof row.queryIndex === "number" &&
                row.queryIndex >= 0 &&
                row.queryIndex < counts.length &&
                typeof row.count === "number"
            ) {
                counts[row.queryIndex] = row.count;
            }
        }
        return counts;
    } catch {
        // Malformed FTS syntax that survived sanitization is non-discriminative.
        return Array.from({ length: ftsQueries.length }, () => 0);
    }
}

function getMessageOrdinal(value: number | string | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

/** Linear decay message scoring.
 *
 * rank-0 = 1.0, rank-1 = 0.9, rank-2 = 0.8 … rank-N = 0.1. Combined with
 * MESSAGE_SOURCE_BOOST this lets raw-history hits actually compete. */
function linearDecayScore(rank: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, 1 - rank / total);
}

interface NormalizedMessageRow {
    messageOrdinal: number;
    messageId: string;
    role: string;
    content: string;
}

/** Convert one FTS row into the validated shape consumed by message ranking. */
function normalizeMessageSearchRow(
    row: MessageSearchRow,
    cutoff: number | null,
): NormalizedMessageRow | null {
    const messageOrdinal = getMessageOrdinal(row.messageOrdinal);
    if (
        messageOrdinal === null ||
        typeof row.messageId !== "string" ||
        typeof row.role !== "string" ||
        typeof row.content !== "string"
    ) {
        return null;
    }
    // Defense-in-depth: every SQL path applies the cutoff before LIMIT.
    if (cutoff !== null && messageOrdinal > cutoff) return null;
    return {
        messageOrdinal,
        messageId: row.messageId,
        role: row.role,
        content: row.content,
    };
}

/** Run one FTS query and return ordinal-cutoff-filtered, validated rows in
 *  bm25 rank order. `ftsQuery` must already be sanitized. */
function runMessageFtsQuery(
    db: Database,
    sessionId: string,
    ftsQuery: string,
    fetchLimit: number,
    cutoff: number | null,
): NormalizedMessageRow[] {
    if (ftsQuery.length === 0) return [];
    // Apply the ordinal cutoff IN SQL (before LIMIT) so live-tail matches can't
    // crowd out older eligible hits; null cutoff keeps the original statement.
    const rows = (
        cutoff !== null
            ? getMessageSearchStatementWithCutoff(db).all(sessionId, ftsQuery, cutoff, fetchLimit)
            : getMessageSearchStatement(db).all(sessionId, ftsQuery, fetchLimit)
    ).map((row) => row as MessageSearchRow);

    const result: NormalizedMessageRow[] = [];
    for (const row of rows) {
        const normalized = normalizeMessageSearchRow(row, cutoff);
        if (normalized) result.push(normalized);
    }
    return result;
}

function getBatchedMessageSearchStatement(
    db: Database,
    queryCount: number,
    cutoff: number | null,
): PreparedStatement {
    let statements = batchedMessageSearchStatements.get(db);
    if (!statements) {
        statements = new Map();
        batchedMessageSearchStatements.set(db, statements);
    }
    const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}`;
    let statement = statements.get(key);
    if (!statement) {
        const cutoffSql = cutoff === null ? "" : " AND CAST(message_ordinal AS INTEGER) <= ?";
        const branches = Array.from(
            { length: queryCount },
            (_, index) => `SELECT * FROM (
                SELECT ${index} AS queryIndex,
                       message_ordinal AS messageOrdinal,
                       message_id AS messageId,
                       role,
                       content,
                       bm25(message_history_fts) AS ftsRank
                  FROM message_history_fts
                 WHERE session_id = ? AND message_history_fts MATCH ?${cutoffSql}
                 ORDER BY ftsRank
                 LIMIT ?
            )`,
        );
        statement = db.prepare(
            `${branches.join("\nUNION ALL\n")}\nORDER BY queryIndex ASC, ftsRank ASC`,
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Run all base/probe result queries as one compound SQLite statement. */
function runMessageFtsQueriesBatch(
    db: Database,
    sessionId: string,
    ftsQueries: readonly string[],
    fetchLimit: number,
    cutoff: number | null,
): NormalizedMessageRow[][] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        bindings.push(sessionId, query);
        if (cutoff !== null) bindings.push(cutoff);
        bindings.push(fetchLimit);
    }
    const rows = getBatchedMessageSearchStatement(db, ftsQueries.length, cutoff).all(
        ...bindings,
    ) as BatchedMessageSearchRow[];
    const result = Array.from({ length: ftsQueries.length }, () => [] as NormalizedMessageRow[]);
    for (const row of rows) {
        if (
            typeof row.queryIndex !== "number" ||
            row.queryIndex < 0 ||
            row.queryIndex >= result.length
        ) {
            continue;
        }
        const normalized = normalizeMessageSearchRow(row, cutoff);
        if (normalized) result[row.queryIndex].push(normalized);
    }
    return result;
}

// Reciprocal-rank-fusion constant. 60 is the canonical RRF k.
const RRF_K = 60;
// Verbatim containment is worth one extra rank-0 list appearance.
const VERBATIM_RANK_BONUS = 1 / RRF_K;
const IDF_FALLOFF = 100;

/** Smooth document-frequency weight for one probe within a session corpus. */
function probeDiscriminationWeight(df: number, corpusSize: number): number {
    if (corpusSize <= 0 || df <= 0) return 1;
    return 1 / (1 + (IDF_FALLOFF * df) / corpusSize);
}

function searchMessages(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
    /** Only return messages with ordinal ≤ this value. Omit or -1 to search all indexed messages. */
    maxOrdinal?: number;
    /** Literal probes to additionally query (multi-probe recall). Empty = the
     *  original single-query behavior. */
    probes?: string[];
}): MessageSearchResult[] {
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    const fetchLimit =
        args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.limit * 3 : args.limit;

    const baseQuery = sanitizeFtsQuery(args.query.trim());
    const probes = args.probes ?? [];

    // No probes → original single-query path, byte-identical scoring.
    if (probes.length === 0) {
        const filtered = runMessageFtsQuery(
            args.db,
            args.sessionId,
            baseQuery,
            fetchLimit,
            cutoff,
        ).slice(0, args.limit);
        return filtered.map((row, rank) => ({
            source: "message" as const,
            content: previewText(row.content),
            score: linearDecayScore(rank, filtered.length),
            messageOrdinal: row.messageOrdinal,
            messageId: row.messageId,
            role: row.role,
        }));
    }

    // Multi-probe: run the full query plus every literal probe as separate FTS
    // rankings, batched into one compound SQLite statement.
    const sanitizedProbes = probes
        .map((probe) => ({ probe, query: sanitizeFtsQuery(probe) }))
        .filter((entry) => entry.query.length > 0);
    const corpusSize = getIndexedMessageCorpusSize(args.db, args.sessionId, cutoff);
    const probeCounts = countSessionFtsMatchesBatch(
        args.db,
        args.sessionId,
        sanitizedProbes.map((entry) => entry.query),
        cutoff,
    );
    const searchQueries = [
        ...(baseQuery.length > 0 ? [baseQuery] : []),
        ...sanitizedProbes.map((entry) => entry.query),
    ];
    const rowsByQuery = runMessageFtsQueriesBatch(
        args.db,
        args.sessionId,
        searchQueries,
        fetchLimit,
        cutoff,
    );

    const queryLists: Array<{ rows: NormalizedMessageRow[]; weight: number }> = [];
    let queryIndex = 0;
    if (baseQuery.length > 0) {
        queryLists.push({
            rows: rowsByQuery[queryIndex] ?? [],
            weight: 1,
        });
        queryIndex += 1;
    }
    const probeWeights = new Map<string, number>();
    sanitizedProbes.forEach((entry, probeIndex) => {
        const weight = probeDiscriminationWeight(probeCounts[probeIndex] ?? 0, corpusSize);
        probeWeights.set(entry.probe, weight);
        queryLists.push({ rows: rowsByQuery[queryIndex] ?? [], weight });
        queryIndex += 1;
    });

    const fused = new Map<string, { row: NormalizedMessageRow; score: number }>();
    for (const list of queryLists) {
        list.rows.forEach((row, rank) => {
            const rrf = list.weight / (RRF_K + rank);
            const existing = fused.get(row.messageId);
            if (existing) {
                existing.score += rrf;
            } else {
                fused.set(row.messageId, { row, score: rrf });
            }
        });
    }

    // Verbatim boost: a message that literally contains a probe is exactly what
    // a symbol/command lookup wants surfaced first.
    for (const entry of fused.values()) {
        let best = 0;
        for (const probe of probes) {
            const weight = probeWeights.get(probe) ?? 0;
            if (weight > best && containsProbeVerbatim(entry.row.content, [probe])) {
                best = weight;
            }
        }
        if (best > 0) {
            entry.score += best * VERBATIM_RANK_BONUS;
        }
    }

    const ranked = [...fused.values()]
        .sort((a, b) =>
            b.score !== a.score ? b.score - a.score : a.row.messageOrdinal - b.row.messageOrdinal,
        )
        .slice(0, args.limit);

    return ranked.map((entry, rank) => ({
        source: "message" as const,
        content: previewText(entry.row.content),
        score: linearDecayScore(rank, ranked.length),
        messageOrdinal: entry.row.messageOrdinal,
        messageId: entry.row.messageId,
        role: entry.row.role,
    }));
}

function searchCompartmentChunks(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    queryEmbedding: Float32Array | null;
    limit: number;
    maxOrdinal?: number;
    modelId?: string | null;
}): CompartmentSearchResult[] {
    if (!args.queryEmbedding || args.limit <= 0 || !args.modelId || args.modelId === "off")
        return [];
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    const rows = loadCompartmentChunkEmbeddingsForSearch(
        args.db,
        args.sessionId,
        args.projectPath,
        args.modelId,
    );
    if (rows.length === 0) return [];

    const byCompartment = new Map<
        number,
        { row: StoredCompartmentChunkEmbedding; score: number }
    >();
    for (const row of rows) {
        if (cutoff !== null && row.endOrdinal > cutoff) {
            continue;
        }
        const score = normalizeCosineScore(cosineSimilarity(args.queryEmbedding, row.vector));
        if (score <= 0) continue;
        const existing = byCompartment.get(row.compartmentId);
        if (!existing || score > existing.score) {
            byCompartment.set(row.compartmentId, { row, score });
        }
    }

    return [...byCompartment.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.row.startOrdinal - right.row.startOrdinal,
        )
        .slice(0, args.limit)
        .map(({ row, score }) => ({
            source: "compartment" as const,
            content: previewText(row.title),
            score: score * SINGLE_SOURCE_PENALTY,
            compartmentId: row.compartmentId,
            sessionId: row.sessionId,
            title: row.title,
            startOrdinal: row.startOrdinal,
            endOrdinal: row.endOrdinal,
            matchType: "semantic" as const,
        }));
}

function mergeMessageAndCompartmentResults(args: {
    messages: MessageSearchResult[];
    compartments: CompartmentSearchResult[];
    limit: number;
}): UnifiedSearchResult[] {
    if (args.compartments.length === 0) return args.messages;
    if (args.messages.length === 0) return args.compartments;

    const fused = new Map<
        string,
        {
            result: UnifiedSearchResult;
            score: number;
            tieOrdinal: number;
            snippetScore: number;
        }
    >();

    const add = (key: string, result: UnifiedSearchResult, score: number, tieOrdinal: number) => {
        const existing = fused.get(key);
        if (existing) {
            existing.score += score;
            return existing;
        }
        const entry = { result, score, tieOrdinal, snippetScore: -1 };
        fused.set(key, entry);
        return entry;
    };

    args.compartments.forEach((compartment, rank) => {
        add(
            `compartment:${compartment.compartmentId}`,
            compartment,
            1 / (RRF_K + rank),
            compartment.startOrdinal,
        );
    });

    for (const [rank, message] of args.messages.entries()) {
        const containing = args.compartments.find(
            (compartment) =>
                message.messageOrdinal >= compartment.startOrdinal &&
                message.messageOrdinal <= compartment.endOrdinal,
        );
        const contribution = 1 / (RRF_K + rank);
        if (!containing) {
            add(`message:${message.messageId}`, message, contribution, message.messageOrdinal);
            continue;
        }

        const entry = add(
            `compartment:${containing.compartmentId}`,
            containing,
            contribution,
            containing.startOrdinal,
        );
        if (message.score > entry.snippetScore && entry.result.source === "compartment") {
            entry.snippetScore = message.score;
            entry.result = {
                ...entry.result,
                matchType: "hybrid",
                snippet: message.content,
            };
        }
    }

    const ranked = [...fused.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.tieOrdinal - right.tieOrdinal,
        )
        .slice(0, args.limit);

    return ranked.map((entry, rank) => ({
        ...entry.result,
        score: linearDecayScore(rank, ranked.length),
    }));
}

function compareUnifiedResults(left: UnifiedSearchResult, right: UnifiedSearchResult): number {
    const leftEffective = left.score * MESSAGE_SOURCE_BOOST;
    const rightEffective = right.score * MESSAGE_SOURCE_BOOST;

    if (rightEffective !== leftEffective) {
        return rightEffective - leftEffective;
    }

    if (left.source === "message" && right.source === "message") {
        return left.messageOrdinal - right.messageOrdinal;
    }

    if (left.source === "compartment" && right.source === "compartment") {
        return left.startOrdinal - right.startOrdinal;
    }

    return 0;
}

function resolveSources(sources: SearchSource[] | undefined): Set<SearchSource> {
    if (sources === undefined) {
        return new Set<SearchSource>(["message"]);
    }
    const set = new Set<SearchSource>();
    for (const source of sources) {
        if (source === "message") {
            set.add(source);
        }
    }
    return set;
}

export async function unifiedSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult[]> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        return [];
    }

    const limit = normalizeLimit(options.limit);
    const tierLimit = Math.max(limit * 3, DEFAULT_UNIFIED_SEARCH_LIMIT);

    const embeddingEnabled = options.embeddingEnabled ?? true;
    const embedQuery = options.embedQuery;
    const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? (() => true);
    const activeSources = resolveSources(options.sources);

    const runMessages = activeSources.has("message");
    // Compartment chunk search shares the message source (it IS message history,
    // summarized) and requires an injected query embedder.
    const runCompartmentChunks = runMessages && embeddingEnabled;

    const needsEmbedding = runCompartmentChunks && isEmbeddingRuntimeEnabled();

    const queryEmbeddingPromise: Promise<CapturedQueryEmbedding | Float32Array | null> =
        needsEmbedding && embedQuery
            ? embedQuery(trimmedQuery, options.signal).catch((error) => {
                  log(
                      `[search] query embedding failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  return null;
              })
            : Promise.resolve(null);

    // Yield to the event loop so the embed fetch's request gets a chance to be
    // dispatched at the runtime level before we run any synchronous work.
    await Promise.resolve();

    // Run the synchronous message-FTS SELECT now that the embed fetch is in
    // flight. Message indexing is event-driven and never runs here.
    const messageProbes = options.explicitSearch ? extractLiteralProbes(trimmedQuery) : [];
    const messageResults: MessageSearchResult[] = runMessages
        ? searchMessages({
              db,
              sessionId,
              query: trimmedQuery,
              limit: tierLimit,
              maxOrdinal: options.maxMessageOrdinal,
              probes: messageProbes,
          })
        : [];

    // Wait for the single embed call (if any) and then run the semantic
    // compartment-chunk search using the same vector.
    const capturedQuery = await queryEmbeddingPromise;
    const queryContract =
        capturedQuery instanceof Float32Array || capturedQuery === null ? null : capturedQuery;
    const queryEmbedding =
        queryContract?.vector ?? (capturedQuery instanceof Float32Array ? capturedQuery : null);
    const chunkModelId = queryContract?.chunkModelId ?? options.chunkModelIdOverride;
    const compartmentResults = runCompartmentChunks
        ? searchCompartmentChunks({
              db,
              sessionId,
              projectPath,
              queryEmbedding,
              limit: tierLimit,
              maxOrdinal: options.maxMessageOrdinal,
              modelId: chunkModelId && chunkModelId !== "off" ? chunkModelId : null,
          })
        : [];
    const results = mergeMessageAndCompartmentResults({
        messages: messageResults,
        compartments: compartmentResults,
        limit: tierLimit,
    })
        .sort(compareUnifiedResults)
        .slice(0, limit);

    return results;
}
