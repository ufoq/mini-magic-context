import { describe, expect, it, spyOn } from "bun:test";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxSearchTool } from "./ctx-search";

describe("createCtxSearchTool", () => {
	it("prints ctx_expand ranges and footer for message search hits", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "message",
						content: "prior conversation detail",
						score: 0.87,
						messageOrdinal: 12,
						role: "user",
						matchType: "fts",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				embeddingEnabled: false,
			});

			const result = await tool.execute(
				"call-1",
				{ query: "prior detail", sources: ["message"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("ordinal=12 range=9-15 role=user");
			expect(text).toContain(
				"Use ctx_expand(start, end) with the range from any message result above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("formats compartment hits as message history results", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "compartment",
						content: "Condensed branch planning notes.",
						snippet: "branch planning",
						score: 0.91,
						compartmentId: 5,
						startOrdinal: 4,
						endOrdinal: 19,
						title: "Planning",
						matchType: "embedding",
					},
				] satisfies UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				embeddingEnabled: false,
			});

			const result = await tool.execute(
				"call-2",
				{ query: "branch planning", sources: ["message"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain(
				"compartment_id=5 range=4-19 match=embedding title=Planning",
			);
			expect(text).toContain("Snippet: branch planning");
			expect(text).toContain(
				"Use ctx_expand(start, end) with the range from any message result above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});
