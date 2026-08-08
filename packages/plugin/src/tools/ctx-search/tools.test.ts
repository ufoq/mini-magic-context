import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { indexMessagesAfterOrdinal } from "../../features/magic-context/message-index";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import * as searchModule from "../../features/magic-context/search";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxSearchTools } from "./tools";

const toolContext = (sessionID = "ses-search") => ({ sessionID }) as never;
const EXPAND_HINT =
    "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

describe("createCtxSearchTools", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("validates required query", async () => {
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute({ query: "   " }, toolContext());

        expect(result).toBe("Error: 'query' is required.");
    });

    it("preserves an explicit empty sources list as no sources", async () => {
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "alpha", sources: [] },
            toolContext(),
        );

        expect(result).toContain("No results found");
    });

    it("formats message results with inline ranges and one trailing expand hint", async () => {
        replaceAllCompartments(db, "ses-message", [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "m1",
                endMessageId: "m10",
                title: "Compartment",
                content: "Summary",
            },
        ]);
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            embeddingEnabled: false,
            readMessages: () => [
                {
                    ordinal: 5,
                    id: "m5",
                    role: "assistant",
                    parts: [{ type: "text", text: "Alpha migration details are here." }],
                },
                {
                    ordinal: 6,
                    id: "m6",
                    role: "user",
                    parts: [{ type: "text", text: "More alpha migration context." }],
                },
            ],
        });
        indexMessagesAfterOrdinal(
            db,
            "ses-message",
            [
                ...Array.from({ length: 4 }, (_, index) => ({
                    ordinal: index + 1,
                    id: `covered-${index + 1}`,
                    role: "system",
                    parts: [],
                })),
                {
                    ordinal: 5,
                    id: "m5",
                    role: "assistant",
                    parts: [{ type: "text", text: "Alpha migration details are here." }],
                },
                {
                    ordinal: 6,
                    id: "m6",
                    role: "user",
                    parts: [{ type: "text", text: "More alpha migration context." }],
                },
            ],
            0,
            6,
        );

        const result = await tools.ctx_search.execute(
            { query: "alpha migration", sources: ["message"] },
            toolContext("ses-message"),
        );

        expect(result).toContain("[1] [message] score=1.00 ordinal=6 range=3-9 role=user");
        expect(result).toContain("[2] [message] score=0.50 ordinal=5 range=2-8 role=assistant");
        expect(result.split(EXPAND_HINT).length - 1).toBe(1);
        expect(result.endsWith(EXPAND_HINT)).toBe(true);
    });

    it("formats compartment results as message history hits", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "compartment",
                        content: "Recovered planning summary.",
                        snippet: "planning summary",
                        score: 0.72,
                        compartmentId: 12,
                        startOrdinal: 2,
                        endOrdinal: 9,
                        title: "Planning",
                        matchType: "embedding",
                    },
                ] satisfies UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                embeddingEnabled: true,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute(
                { query: "planning", sources: ["message"] },
                toolContext(),
            );

            expect(result).toContain(
                "[1] [message] score=0.72 compartment_id=12 range=2-9 match=embedding title=Planning",
            );
            expect(result).toContain("Snippet: planning summary");
            expect(result).toContain(EXPAND_HINT);
        } finally {
            spy.mockRestore();
        }
    });
});
