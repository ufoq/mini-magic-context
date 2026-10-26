/// <reference types="bun-types" />

import { describe, expect, it, mock, spyOn } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	acquireCompartmentLease,
	releaseCompartmentLease,
} from "@ufoq/mini-magic-context-core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
	getLastCompartmentEndMessage,
} from "@ufoq/mini-magic-context-core/features/magic-context/compartment-storage";
import { updateSessionMeta } from "@ufoq/mini-magic-context-core/features/magic-context/storage";
import { initializeDatabase } from "@ufoq/mini-magic-context-core/features/magic-context/storage-db";
import {
	acquireWrapupInProgress,
	getOverflowState,
	getPendingPiCompactionMarkerState,
	getWrapupInProgressState,
	recordOverflowDetected,
	setPendingPiCompactionMarkerState,
} from "@ufoq/mini-magic-context-core/features/magic-context/storage-meta-persisted";
import {
	readRawSessionMessages,
	setRawMessageProvider,
	withRawMessageProvider,
} from "@ufoq/mini-magic-context-core/hooks/magic-context/read-session-chunk";
import { Database } from "@ufoq/mini-magic-context-core/shared/sqlite";
import { closeQuietly } from "@ufoq/mini-magic-context-core/shared/sqlite-helpers";
import {
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
} from "../context-handler";
import {
	needsPiHistoryCatchup,
	parseWrapupArgs,
	type RegisterCtxWrapupDeps,
	registerCtxWrapupCommand,
	runPiWrapup,
} from "./ctx-wrapup";

function createDb(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	return db;
}

function branch(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `m-${index + 1}`,
		type: "message",
		timestamp: index + 1,
		message: {
			role: "user",
			content: `message ${index + 1} alpha beta gamma delta`,
		},
	}));
}

function ctx(sessionId: string, source: number | unknown[] = 8) {
	const entries = typeof source === "number" ? branch(source) : source;
	return {
		cwd: "/tmp/pi-wrapup",
		hasUI: true,
		model: { provider: "anthropic", id: "claude" },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => entries,
		},
		getContextUsage: () => ({ contextWindow: 20, tokens: 1, percent: 1 }),
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionCommandContext;
}

function fencedToolArcBranch(): unknown[] {
	return [
		{
			id: "m-1",
			type: "message",
			timestamp: 1,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { cmd: "echo start" },
					},
				],
			},
		},
		{
			id: "m-2",
			type: "message",
			timestamp: 2,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "assistant while tool is pending" }],
			},
		},
		{
			id: "m-3",
			type: "message",
			timestamp: 3,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "more assistant while pending" }],
			},
		},
		{
			id: "m-4",
			type: "message",
			timestamp: 4,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "tool output" }],
			},
		},
		{
			id: "m-5",
			type: "message",
			timestamp: 5,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "assistant after tool result" }],
			},
		},
		{
			id: "m-6",
			type: "message",
			timestamp: 6,
			message: { role: "user", content: "protected live tail" },
		},
	];
}

function pi() {
	const sent: Array<{ message: { content: string } }> = [];
	return {
		api: {
			sendMessage(message: { content: string }) {
				sent.push({ message });
			},
		} as never,
		sent,
	};
}

function appendRange(
	db: Database,
	sessionId: string,
	start: number,
	end: number,
): void {
	if (end < start) return;
	appendCompartments(db, sessionId, [
		{
			sequence: getCompartments(db, sessionId).length,
			startMessage: start,
			endMessage: end,
			startMessageId: `m-${start}`,
			endMessageId: `m-${end}`,
			title: `Pi ${start}-${end}`,
			content: `Pi ${start}-${end}`,
		},
	]);
}

function deps(
	db: Database,
	overrides: Partial<RegisterCtxWrapupDeps> = {},
): RegisterCtxWrapupDeps {
	return {
		db,
		runner: {} as never,
		historianModel: "test/model",
		historianChunkTokens: 10,
		memoryEnabled: false,
		autoPromote: false,
		runPiHistorianForWrapup: mock(async (args) => {
			const sessionId = args.sessionId;
			const start = getLastCompartmentEndMessage(db, sessionId) + 1;
			const end = Math.min(
				args.boundarySnapshot.eligibleEndOrdinal - 1,
				start + 2,
			);
			appendRange(db, sessionId, start, end);
			args.onPublished?.();
		}),
		...overrides,
	};
}

describe("Pi /ctx-wrapup", () => {
	it("keeps the outer raw provider registered after the nested async historian scope", async () => {
		const sessionId = "nested-wrapup-provider";
		const provider = {
			readMessages: () => [
				{
					ordinal: 1,
					id: "m-1",
					role: "user",
					parts: [{ type: "text", text: "original" }],
				},
			],
		};
		const unregister = setRawMessageProvider(sessionId, provider);
		try {
			const releaseBorrowedRegistration = setRawMessageProvider(
				sessionId,
				provider,
			);
			releaseBorrowedRegistration();
			expect(readRawSessionMessages(sessionId)).toHaveLength(1);
			await withRawMessageProvider(sessionId, provider, async () => {
				await Promise.resolve();
				expect(readRawSessionMessages(sessionId)).toHaveLength(1);
			});
			expect(readRawSessionMessages(sessionId)).toHaveLength(1);
			await expect(
				withRawMessageProvider(sessionId, provider, async () => {
					throw new Error("interrupted chunk");
				}),
			).rejects.toThrow("interrupted chunk");
			expect(readRawSessionMessages(sessionId)).toHaveLength(1);
		} finally {
			unregister();
		}
		expect(readRawSessionMessages(sessionId)).toHaveLength(0);
	});
	function nativeBranch(count = 80): unknown[] {
		return [
			...branch(count),
			{
				id: "native",
				type: "compaction",
				firstKeptEntryId: "m-50",
				summary: "native summary",
			},
		];
	}

	function activation(
		db: Database,
		overrides: Partial<RegisterCtxWrapupDeps> = {},
	) {
		let start!: (
			_event: never,
			context: ExtensionCommandContext,
		) => Promise<void>;
		const api = {
			on(event: string, handler: typeof start) {
				if (event === "session_start") start = handler;
			},
			registerCommand() {},
			appendEntry() {},
		};
		registerCtxWrapupCommand(api as never, deps(db, overrides));
		return (context: ExtensionCommandContext) => start({} as never, context);
	}

	it("detects uncovered native history using IDs, including partial coverage", () => {
		const entries = nativeBranch();
		expect(needsPiHistoryCatchup(branch(80))).toBe(false);
		expect(needsPiHistoryCatchup(entries)).toBe(true);
		expect(
			needsPiHistoryCatchup(entries, { endMessage: 10, endMessageId: "m-10" }),
		).toBe(true);
		expect(
			needsPiHistoryCatchup(entries, { endMessage: 49, endMessageId: "m-49" }),
		).toBe(false);
		expect(
			needsPiHistoryCatchup(entries, { endMessage: 50, endMessageId: "m-50" }),
		).toBe(false);
		expect(
			needsPiHistoryCatchup(entries, {
				endMessage: 10,
				endMessageId: "different-branch",
			}),
		).toBe(false);
		expect(
			needsPiHistoryCatchup([
				...entries,
				{ type: "compaction", firstKeptEntryId: "missing" },
			]),
		).toBe(false);
		expect(
			needsPiHistoryCatchup([
				...entries,
				{
					type: "compaction",
					firstKeptEntryId: "m-60",
					details: { source: "magic-context" },
				},
			]),
		).toBe(false);
	});

	it("uses canonical ordinals when system messages and folded tools exist", () => {
		const entries = [
			{
				id: "sys",
				type: "message",
				message: { role: "system", content: "scaffolding" },
			},
			...fencedToolArcBranch(),
			{ type: "compaction", firstKeptEntryId: "m-6" },
		];
		// First uncovered ordinal is a synthetic folded tool result, not an entry ID.
		expect(
			needsPiHistoryCatchup(entries, { endMessage: 3, endMessageId: "m-3" }),
		).toBe(true);
		expect(
			needsPiHistoryCatchup(entries, { endMessage: 5, endMessageId: "m-5" }),
		).toBe(false);
	});

	it("awaits startup catch-up, notifies first, and resumes partial progress", async () => {
		const db = createDb();
		try {
			const sid = "activation-catchup";
			const entries = nativeBranch();
			appendRange(db, sid, 1, 10);
			const context = ctx(sid, entries);
			context.getContextUsage = () => ({
				contextWindow: 256_000,
				tokens: 1,
				percent: 1,
			});
			const notices: string[] = [];
			context.ui.notify = (text) => {
				notices.push(text);
			};
			let calls = 0;
			let fail = true;
			const starts: number[] = [];
			const start = activation(db, {
				runPiHistorianForWrapup: mock(async (args) => {
					expect(notices[0]).toContain("Pi will wait");
					expect(getWrapupInProgressState(db, sid)).not.toBeNull();
					expect(args.forceDrainQuota).toBe(true);
					expect(args.readBranchEntries?.()).toEqual(entries);
					const snapshot = args.boundarySnapshot;
					if (!snapshot) throw new Error("Missing wrapup snapshot");
					const first = snapshot.offset;
					starts.push(first);
					if (++calls === 2 && fail) return;
					appendRange(
						db,
						sid,
						first,
						Math.min(first + 9, snapshot.eligibleEndOrdinal - 1),
					);
					args.onPublished?.();
				}),
			});
			await start(context);
			expect(getLastCompartmentEndMessage(db, sid)).toBe(20);
			expect(notices.at(-1)).toContain("Partial");
			expect(getWrapupInProgressState(db, sid)).toBeNull();
			fail = false;
			await start(context);
			expect(starts[2]).toBe(21);
			expect(getLastCompartmentEndMessage(db, sid)).toBe(60);
			expect(getCompartments(db, sid)[0].endMessage).toBe(10);
			expect(entries.at(-1)).toEqual(
				expect.objectContaining({ summary: "native summary" }),
			);
			const previousCalls = calls;
			await start(context);
			expect(calls).toBe(previousCalls);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not initialize fresh sessions, subagents, or disabled historians", async () => {
		const db = createDb();
		try {
			const run = mock(async () => {});
			await activation(db, { runPiHistorianForWrapup: run })(ctx("fresh", 80));
			updateSessionMeta(db, "child", { isSubagent: true });
			await activation(db, { runPiHistorianForWrapup: run })(
				ctx("child", nativeBranch()),
			);
			await activation(db, {
				historianModel: undefined,
				runPiHistorianForWrapup: run,
			})(ctx("disabled", nativeBranch()));
			expect(run).not.toHaveBeenCalled();
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps a fixed target when new messages arrive and rejects changed source history", async () => {
		const db = createDb();
		try {
			const sid = "wrapup-fixed-target";
			const entries: unknown[] = branch(80);
			let calls = 0;
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async (args) => {
						const snapshot = args.boundarySnapshot;
						if (!snapshot) throw new Error("Missing wrapup snapshot");
						const first = snapshot.offset;
						appendRange(
							db,
							sid,
							first,
							Math.min(first + 9, snapshot.eligibleEndOrdinal - 1),
						);
						if (++calls === 1)
							entries.push(
								...branch(20).map((entry, i) => ({
									...entry,
									id: `appended-${i}`,
								})),
							);
					}),
				}),
				ctx(sid, entries),
				sid,
				20,
			);
			expect(result).not.toContain("Partial");
			expect(getLastCompartmentEndMessage(db, sid)).toBe(60);

			const changed = branch(80);
			await expect(
				runPiWrapup(
					pi().api,
					deps(db, {
						runPiHistorianForWrapup: mock(async () => {
							appendRange(db, "changed", 1, 10);
							changed[0].message.content = "edited history";
						}),
					}),
					ctx("changed", changed),
					"changed",
					20,
				),
			).rejects.toThrow("Pi history changed");
			expect(getLastCompartmentEndMessage(db, "changed")).toBe(10);
			expect(getWrapupInProgressState(db, "changed")).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});
	it("reports headless progress without suggesting retries for a successful protected tail", async () => {
		const db = createDb();
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		try {
			const entries: unknown[] = [
				...branch(80),
				{ type: "compaction", firstKeptEntryId: "m-75" },
			];
			const context = ctx("short-native-tail", entries);
			Object.assign(context, { hasUI: false });
			const notices: string[] = [];
			context.ui.notify = (text) => {
				notices.push(text);
			};
			await activation(db)(context);
			expect(getLastCompartmentEndMessage(db, "short-native-tail")).toBe(60);
			expect(notices.at(-1)).not.toContain("continue");
			expect(notices.at(-1)).not.toContain("Partial");
			expect(stderr.mock.calls[0]?.[0]).toContain("Pi will wait");
		} finally {
			stderr.mockRestore();
			closeQuietly(db);
		}
	});

	it("waits for stale startup ownership to expire, then resumes", async () => {
		const db = createDb();
		try {
			const sid = "crashed-wrapup";
			appendRange(db, sid, 1, 10);
			const acquired = acquireWrapupInProgress(db, sid, {
				holderId: "crashed-process",
				messagesToKeep: 20,
				anchorRawMessageCount: 80,
				targetEligibleEndOrdinal: 61,
				lastCompartmentEnd: 10,
				chunkIndex: 1,
				expectedChunks: 5,
			});
			if (!acquired.ok) throw new Error("Failed to seed owner");
			db.prepare(
				"UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?",
			).run(
				JSON.stringify({ ...acquired.state, expiresAt: Date.now() + 20 }),
				sid,
			);
			await activation(db)(ctx(sid, nativeBranch()));
			expect(getLastCompartmentEndMessage(db, sid)).toBe(60);
			expect(getWrapupInProgressState(db, sid)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("parses optional positive messages_to_keep", () => {
		expect(parseWrapupArgs("")).toEqual({ ok: true, messagesToKeep: 20 });
		expect(parseWrapupArgs(" 7 ")).toEqual({ ok: true, messagesToKeep: 7 });
		expect(parseWrapupArgs("0").ok).toBe(false);
		expect(parseWrapupArgs("two").ok).toBe(false);
	});

	it("refuses subagent sessions", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-subagent-wrapup";
			updateSessionMeta(db, sessionId, { isSubagent: true });
			const runPiHistorianForWrapup = mock(async () => {});

			const result = await runPiWrapup(
				pi().api,
				deps(db, { runPiHistorianForWrapup }),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("only available in primary sessions");
			expect(runPiHistorianForWrapup).not.toHaveBeenCalled();
		} finally {
			closeQuietly(db);
		}
	});

	it("stops on no progress and releases the durable marker", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-no-progress";
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async () => {}),
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup — Partial");
			expect(result).toContain("No forward progress");
			expect(result).toContain("Run /ctx-wrapup again to continue");
			const row = db
				.prepare(
					"SELECT wrapup_in_progress_state FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { wrapup_in_progress_state: string | null } | null;
			expect(row?.wrapup_in_progress_state ?? null).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("bounds waiting for a foreign compartment lease and clears the wrapup marker", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-lease-timeout";
			const foreignHolder = "foreign-lease-holder";
			expect(
				acquireCompartmentLease(db, sessionId, foreignHolder),
			).not.toBeNull();
			const runPiHistorianForWrapup = mock(async () => {});

			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup,
					wrapupLeaseWaitTimeoutMs: 0,
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup — Partial");
			expect(result).toContain("Timed out waiting");
			expect(runPiHistorianForWrapup).not.toHaveBeenCalled();
			expect(getWrapupInProgressState(db, sessionId)).toBeNull();
			releaseCompartmentLease(db, sessionId, foreignHolder);
		} finally {
			closeQuietly(db);
		}
	});

	it("signals deferred history and materialization after a wrapup publish", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-signals";
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async (args) => {
						appendRange(db, sessionId, 1, 3);
						args.onPublished?.();
					}),
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup");
			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("passes the active session model as the wrapup historian last-resort fallback", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-session-model";
			const runPiHistorianForWrapup = mock(async (args) => {
				appendRange(db, sessionId, 1, 3);
				args.onPublished?.();
			});

			await runPiWrapup(
				pi().api,
				deps(db, { runPiHistorianForWrapup }),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(runPiHistorianForWrapup).toHaveBeenCalledWith(
				expect.objectContaining({ fallbackModelId: "anthropic/claude" }),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("aborts when wrapup marker ownership is lost and leaves the foreign marker", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-ownership-lost";
			let calls = 0;
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async (args) => {
						calls += 1;
						appendRange(db, sessionId, 1, 3);
						args.onPublished?.();
						const state = getWrapupInProgressState(db, sessionId);
						expect(state).not.toBeNull();
						db.prepare(
							"UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?",
						).run(
							JSON.stringify({
								...state,
								holderId: "foreign-holder",
								updatedAt: Date.now(),
								expiresAt: Date.now() + 60_000,
							}),
							sessionId,
						);
					}),
				}),
				ctx(sessionId, 10),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup — Partial");
			expect(result).toContain(
				"another process took over this session's wrapup",
			);
			expect(calls).toBe(1);
			expect(getWrapupInProgressState(db, sessionId)?.holderId).toBe(
				"foreign-holder",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("leaves the pending Pi marker queued until the next consuming context pass", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-marker-pending";
			const result = await runPiWrapup(
				pi().api,
				deps(db, {
					runPiHistorianForWrapup: mock(async (args) => {
						const start = getLastCompartmentEndMessage(db, sessionId) + 1;
						const end = Math.min(
							args.boundarySnapshot.eligibleEndOrdinal - 1,
							start + 2,
						);
						appendRange(db, sessionId, start, end);
						setPendingPiCompactionMarkerState(db, sessionId, {
							firstKeptEntryId: `m-${end + 1}`,
							endMessageId: `m-${end}`,
							ordinal: end,
							tokensBefore: 123 + end,
							summary: `pending marker ${end}`,
							publishedAt: Date.now(),
						});
						args.onPublished?.();
					}),
				}),
				ctx(sessionId, 8),
				sessionId,
				2,
			);

			expect(result).toContain("## Magic Wrapup");
			expect(result).not.toContain("## Magic Wrapup — Partial");
			expect(getLastCompartmentEndMessage(db, sessionId)).toBe(6);
			expect(getPendingPiCompactionMarkerState(db, sessionId)).toEqual(
				expect.objectContaining({ ordinal: 6, endMessageId: "m-6" }),
			);
			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("reports partial when a fenced boundary has no runnable wrapup window", async () => {
		const db = createDb();
		try {
			const sessionId = "pi-wrapup-fenced-zero-progress";
			recordOverflowDetected(db, sessionId, 20, "anthropic/claude");
			const result = await runPiWrapup(
				pi().api,
				deps(db),
				ctx(sessionId, fencedToolArcBranch()),
				sessionId,
				3,
			);

			expect(result).toContain("## Magic Wrapup — Partial");
			expect(result).toContain("No runnable wrapup boundary");
			expect(result).toContain("Run /ctx-wrapup again");
			expect(getLastCompartmentEndMessage(db, sessionId)).toBe(-1);
			expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});
});
