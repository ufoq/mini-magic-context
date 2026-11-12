import { describe, expect, it, spyOn } from "bun:test";
import { homedir } from "node:os";
import type { UnifiedSearchResult } from "@ufoq/mini-magic-context-core/features/magic-context/search";
import * as searchModule from "@ufoq/mini-magic-context-core/features/magic-context/search";
import { closeQuietly } from "@ufoq/mini-magic-context-core/shared/sqlite-helpers";
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

	it("falls back to message-only search when cwd is the user's home", async () => {
		const db = createTestDb();
		let captured:
			| {
					projectPath: string | undefined;
					embeddingEnabled: boolean | undefined;
					sources: readonly string[] | undefined;
					embedQuery: unknown;
					registrationCalled: boolean;
			  }
			| undefined;
		let registrationCalled = false;
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async (_db, _sessionId, projectPath, _query, options) => {
				captured = {
					projectPath,
					embeddingEnabled: options?.embeddingEnabled,
					sources: options?.sources,
					embedQuery: options?.embedQuery,
					registrationCalled,
				};
				return [];
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				embeddingEnabled: true,
				ensureProjectRegistered: async () => {
					registrationCalled = true;
				},
			});

			const result = await tool.execute(
				"call-home",
				{ query: "workers ssh remote test machines" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-home", homedir()) as never,
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text ?? "").toContain("No results found");
			expect(captured?.projectPath).toBe("");
			expect(captured?.embeddingEnabled).toBe(false);
			expect(captured?.sources).toEqual(["message"]);
			expect(captured?.embedQuery).toBeUndefined();
			expect(captured?.registrationCalled).toBe(false);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("returns raw-history hits for a home session without an error", async () => {
		const db = createTestDb();
		db.prepare(
			"INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"ses-home-hit",
			1,
			1,
			10,
			"m1",
			"m10",
			"Home history",
			"Home history",
			"Home history",
			Date.now(),
		);
		db.prepare(
			"INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
		).run(
			"ses-home-hit",
			5,
			"m5",
			"user",
			"The workers ssh remote test machines use port 47001.",
		);
		db.prepare(
			"INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
		).run(
			"ses-home-hit",
			15,
			"m15",
			"user",
			"LIVE_TAIL: workers ssh remote test machines must not be searched yet.",
		);
		try {
			const tool = createCtxSearchTool({
				db,
				embeddingEnabled: true,
			});

			const result = await tool.execute(
				"call-home-hit",
				{ query: "workers ssh remote test machines" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-home-hit", homedir()) as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(result.isError).toBeUndefined();
			expect(text).toContain("port 47001");
			expect(text).not.toContain("LIVE_TAIL");
		} finally {
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
