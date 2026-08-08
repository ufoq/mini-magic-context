/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";

let queryEmbedding: Float32Array | null = null;
let chunkModelId: string | null = null;
const embeddingQueries: string[] = [];
const rawMessagesBySession = new Map<
    string,
    Array<{ ordinal: number; id: string; role: string; parts: unknown[] }>
>();

import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import { ensureMessagesIndexed } from "./message-index";
import { runMigrations } from "./migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import { unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

const readMessages = (sessionId: string) => rawMessagesBySession.get(sessionId) ?? [];
const embedQuery = async (text: string) => {
    embeddingQueries.push(text);
    if (!queryEmbedding) return null;
    return {
        vector: new Float32Array(queryEmbedding),
        modelId: "mock:model",
        chunkModelId: chunkModelId ?? "mock:chunk",
        generation: 0,
    };
};
const isEmbeddingRuntimeEnabled = () => true;

function seedCompartmentChunkEmbedding(
    db: Database,
    sessionId: string,
    projectPath: string,
    vector: Float32Array,
    modelId = "mock:chunk",
): number {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "u1",
            endMessageId: "a2",
            title: "Queue saturation design",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
    const compartment = getCompartments(db, sessionId)[0];
    const windows = chunkCanonicalText(
        "[1] U: queue saturation problem\n[2] A: bounded drains with backpressure",
        1,
        2,
        10_000,
    );
    replaceCompartmentChunkEmbeddings(
        db,
        windows.map((window) => ({
            compartmentId: compartment.id,
            sessionId,
            projectPath,
            window,
            modelId,
            vector,
        })),
    );
    return compartment.id;
}

function registerEmbeddingProject(db: Database, projectPath: string) {
    const snapshot = registerProjectEmbedding(
        db,
        projectPath,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: true },
        projectPath,
    );
    chunkModelId = snapshot.chunkModelId;
    return snapshot;
}

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    // runMigrations is retained so the schema matches production openDatabase().
    runMigrations(db);
    return db;
}

afterEach(() => {
    queryEmbedding = null;
    chunkModelId = null;
    embeddingQueries.length = 0;
    rawMessagesBySession.clear();
    _resetProjectEmbeddingRegistryForTests();
});

describe("unifiedSearch", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("returns empty results for blank queries or missing sessions", async () => {
        expect(
            await unifiedSearch(db, "ses-empty", "/repo/project", "   ", {
                embeddingEnabled: true,
                embedQuery,
                isEmbeddingRuntimeEnabled,
            }),
        ).toEqual([]);

        expect(
            await unifiedSearch(db, "ses-empty", "/repo/project", "nothing", {
                embeddingEnabled: false,
            }),
        ).toEqual([]);
    });

    it("returns empty message results until async indexing populates FTS", async () => {
        rawMessagesBySession.set("ses-2", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>ignore</system-reminder> Search this ticket",
                    },
                ],
            },
            {
                ordinal: 2,
                id: "tool-1",
                role: "assistant",
                parts: [{ type: "tool-call", name: "ctx_note" }],
            },
            {
                ordinal: 3,
                id: "a1",
                role: "assistant",
                parts: [{ type: "text", text: "Ticket search is now indexed." }],
            },
        ]);

        let results = await unifiedSearch(db, "ses-2", "/repo/project", "ticket", {
            embeddingEnabled: false,
        });

        expect(results.filter((result) => result.source === "message")).toHaveLength(0);

        ensureMessagesIndexed(db, "ses-2", readMessages);

        results = await unifiedSearch(db, "ses-2", "/repo/project", "ticket", {
            embeddingEnabled: false,
        });

        expect(results.filter((result) => result.source === "message")).toHaveLength(2);

        rawMessagesBySession.set("ses-2", [
            ...(rawMessagesBySession.get("ses-2") ?? []),
            {
                ordinal: 4,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "The indexed ticket search now supports history." }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-2", readMessages);

        results = await unifiedSearch(db, "ses-2", "/repo/project", "supports history", {
            embeddingEnabled: false,
        });

        const messageResults = results.filter(
            (result): result is Extract<(typeof results)[number], { source: "message" }> =>
                result.source === "message",
        );
        expect(messageResults).toHaveLength(1);
        expect(messageResults[0]?.messageOrdinal).toBe(4);
    });

    it("maxMessageOrdinal=0 excludes every message (no compartment yet → whole tail is live)", async () => {
        // Issue #131: before the historian first runs there are no compartments,
        // so the ctx_search tool passes a cutoff of 0. Ordinals are 1-based, so a
        // 0 cutoff must exclude EVERY indexed message — none have scrolled out of
        // the live context the agent already sees (incl. the current prompt).
        rawMessagesBySession.set("ses-1", [
            {
                ordinal: 1,
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "delete all entries in the ranked_search table" }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [{ type: "text", text: "ranked_search table cleanup acknowledged." }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-1", readMessages);

        const results = await unifiedSearch(db, "ses-1", "/repo/project", "ranked_search", {
            embeddingEnabled: false,
            maxMessageOrdinal: 0,
        });

        // No message results — the current prompt must NOT come back.
        expect(results.filter((r) => r.source === "message")).toHaveLength(0);
    });

    it("restricts results to the sources filter (message is the only source)", async () => {
        rawMessagesBySession.set("ses-sources", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "What prompt does the historian agent use?" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-sources", readMessages);

        // Message-only filter returns message hits.
        const messageOnly = await unifiedSearch(
            db,
            "ses-sources",
            "/repo/project",
            "historian prompt",
            {
                embeddingEnabled: false,
                sources: ["message"],
            },
        );
        expect(messageOnly.every((r) => r.source === "message")).toBe(true);
        expect(messageOnly.length).toBeGreaterThan(0);

        // An explicit [] is treated as "no sources" → empty.
        const none = await unifiedSearch(db, "ses-sources", "/repo/project", "historian prompt", {
            embeddingEnabled: false,
            sources: [],
        });
        expect(none).toEqual([]);
    });

    it("uses linear decay for message scoring so secondary hits keep signal", async () => {
        rawMessagesBySession.set("ses-decay", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "regression regression regression one" }],
            },
            {
                ordinal: 2,
                id: "u2",
                role: "user",
                parts: [{ type: "text", text: "regression regression two" }],
            },
            {
                ordinal: 3,
                id: "u3",
                role: "user",
                parts: [{ type: "text", text: "regression three" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-decay", readMessages);

        const results = await unifiedSearch(db, "ses-decay", "/repo/decay", "regression", {
            embeddingEnabled: false,
            sources: ["message"],
        });

        const messages = results.filter(
            (r): r is Extract<(typeof results)[number], { source: "message" }> =>
                r.source === "message",
        );
        expect(messages.length).toBeGreaterThanOrEqual(3);
        expect(messages[0].score).toBeGreaterThan(0.9);
        expect(messages[1].score).toBeGreaterThan(0.5);
        expect(messages[2].score).toBeGreaterThan(0.2);
    });

    it("explicitSearch recalls a literal-symbol message the AND-joined NL query misses", async () => {
        rawMessagesBySession.set("ses-probe", [
            {
                ordinal: 1,
                id: "m1",
                role: "assistant",
                parts: [{ type: "text", text: "Fixed the /ctx-status tool count breakdown." }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "user",
                parts: [{ type: "text", text: "unrelated chatter about something else entirely" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-probe", readMessages);

        const nlQuery = "why did the inflated tool calls breakdown happen in ctx-status";

        const baseline = await unifiedSearch(db, "ses-probe", "/repo/probe", nlQuery, {
            embeddingEnabled: false,
            sources: ["message"],
        });
        expect(baseline.some((r) => r.source === "message" && r.messageId === "m1")).toBe(false);

        const probed = await unifiedSearch(db, "ses-probe", "/repo/probe", nlQuery, {
            embeddingEnabled: false,
            sources: ["message"],
            explicitSearch: true,
        });
        const probedMessages = probed.filter((r) => r.source === "message");
        expect(probedMessages.some((r) => r.messageId === "m1")).toBe(true);
        expect(probedMessages[0]?.messageId).toBe("m1");
    });

    it("counts probe corpus statistics only inside the message cutoff", async () => {
        rawMessagesBySession.set("ses-cutoff-probes", [
            {
                ordinal: 1,
                id: "common-1",
                role: "assistant",
                parts: [{ type: "text", text: "CommonTerm is the eligible early hit." }],
            },
            {
                ordinal: 2,
                id: "rare-2",
                role: "assistant",
                parts: [{ type: "text", text: "RareSymbolXyz is the eligible late hit." }],
            },
            ...Array.from({ length: 12 }, (_, i) => ({
                ordinal: i + 3,
                id: `tail-${i}`,
                role: "assistant" as const,
                parts: [
                    {
                        type: "text" as const,
                        text: `CommonTerm appears again in excluded live-tail row ${i}.`,
                    },
                ],
            })),
        ]);
        ensureMessagesIndexed(db, "ses-cutoff-probes", readMessages);

        const results = await unifiedSearch(
            db,
            "ses-cutoff-probes",
            "/repo/probe-cutoff",
            "RareSymbolXyz CommonTerm",
            {
                embeddingEnabled: false,
                sources: ["message"],
                explicitSearch: true,
                maxMessageOrdinal: 2,
            },
        );

        const messages = results.filter((r) => r.source === "message");
        expect(messages.map((r) => r.messageId)).toEqual(["common-1", "rare-2"]);
    });

    it("multi-probe scores decay linearly instead of flattening into a ~1.0 band", async () => {
        const msgs = Array.from({ length: 8 }, (_, i) => ({
            ordinal: i + 1,
            id: `mm${i}`,
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: `note ${i}: the /ctx-status dialog rendering pass number ${i}`,
                },
            ],
        }));
        rawMessagesBySession.set("ses-band", msgs);
        ensureMessagesIndexed(db, "ses-band", readMessages);

        const results = await unifiedSearch(db, "ses-band", "/repo/band", "ctx-status dialog", {
            embeddingEnabled: false,
            sources: ["message"],
            explicitSearch: true,
        });
        const messages = results.filter((r) => r.source === "message");
        expect(messages.length).toBeGreaterThanOrEqual(4);
        expect(messages[0].score).toBeGreaterThan(0.9);
        const second = messages[1].score;
        const last = messages[messages.length - 1].score;
        expect(second).toBeLessThan(0.95);
        expect(last).toBeLessThan(0.5);
    });

    it("a discriminative probe outranks a corpus-flooding probe", async () => {
        const flood = Array.from({ length: 30 }, (_, i) => ({
            ordinal: i + 1,
            id: `f${i}`,
            role: "assistant",
            parts: [{ type: "text", text: `CommonTerm appears here in filler message ${i}` }],
        }));
        const rare = {
            ordinal: 31,
            id: "rare-hit",
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: "RareSymbolXyz was fixed alongside CommonTerm in the resolver",
                },
            ],
        };
        rawMessagesBySession.set("ses-idf", [...flood, rare]);
        ensureMessagesIndexed(db, "ses-idf", readMessages);

        const results = await unifiedSearch(
            db,
            "ses-idf",
            "/repo/idf",
            "where did we fix RareSymbolXyz near CommonTerm",
            {
                embeddingEnabled: false,
                sources: ["message"],
                explicitSearch: true,
            },
        );
        const messages = results.filter((r) => r.source === "message");
        expect(messages[0]?.messageId).toBe("rare-hit");
    });

    it("returns a semantic compartment hit for message-only conceptual search", async () => {
        rawMessagesBySession.set("ses-chunk", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "queue saturation problem" }],
            },
            {
                ordinal: 2,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "bounded drains with backpressure" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-chunk", readMessages);
        const snapshot = registerEmbeddingProject(db, "/repo/chunk");
        const compartmentId = seedCompartmentChunkEmbedding(
            db,
            "ses-chunk",
            "/repo/chunk",
            new Float32Array([0, 1]),
            snapshot.chunkModelId,
        );
        queryEmbedding = new Float32Array([0, 1]);

        const results = await unifiedSearch(db, "ses-chunk", "/repo/chunk", "hydraulic flow", {
            limit: 5,
            embeddingEnabled: true,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 2,
        });

        expect(embeddingQueries).toEqual(["hydraulic flow"]);
        expect(results[0]).toMatchObject({
            source: "compartment",
            compartmentId,
            startOrdinal: 1,
            endOrdinal: 2,
            matchType: "semantic",
        });
    });

    it("deduplicates FTS hits inside semantic compartment ranges and keeps a snippet", async () => {
        rawMessagesBySession.set("ses-dedup", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "queue saturation problem" }],
            },
            {
                ordinal: 2,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "bounded drains with backpressure" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-dedup", readMessages);
        const snapshot = registerEmbeddingProject(db, "/repo/chunk");
        seedCompartmentChunkEmbedding(
            db,
            "ses-dedup",
            "/repo/chunk",
            new Float32Array([0, 1]),
            snapshot.chunkModelId,
        );
        queryEmbedding = new Float32Array([0, 1]);

        const results = await unifiedSearch(db, "ses-dedup", "/repo/chunk", "bounded drains", {
            limit: 5,
            embeddingEnabled: true,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 2,
        });

        expect(results.some((result) => result.source === "message")).toBe(false);
        const compartment = results.find((result) => result.source === "compartment");
        expect(compartment).toMatchObject({ source: "compartment", matchType: "hybrid" });
        expect(compartment && "snippet" in compartment ? compartment.snippet : "").toContain(
            "bounded drains",
        );
    });

    it("respects message watermark cutoff and disabled embedding for compartment chunks", async () => {
        rawMessagesBySession.set("ses-cutoff", [
            { ordinal: 1, id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
            { ordinal: 2, id: "a2", role: "assistant", parts: [{ type: "text", text: "second" }] },
        ]);
        ensureMessagesIndexed(db, "ses-cutoff", readMessages);
        seedCompartmentChunkEmbedding(db, "ses-cutoff", "/repo/cutoff", new Float32Array([0, 1]));
        queryEmbedding = new Float32Array([0, 1]);

        const cutoffResults = await unifiedSearch(db, "ses-cutoff", "/repo/cutoff", "concept", {
            limit: 5,
            embeddingEnabled: true,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 1,
        });
        expect(cutoffResults.some((result) => result.source === "compartment")).toBe(false);

        embeddingQueries.length = 0;
        const embeddingOffResults = await unifiedSearch(
            db,
            "ses-cutoff",
            "/repo/cutoff",
            "concept",
            {
                limit: 5,
                embeddingEnabled: false,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["message"],
                maxMessageOrdinal: 2,
            },
        );
        expect(embeddingOffResults.some((result) => result.source === "compartment")).toBe(false);
        expect(embeddingQueries).toEqual([]);
    });
});
