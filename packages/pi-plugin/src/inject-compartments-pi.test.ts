import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getCompartments,
	getOrCreateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { COMPARTMENT_RENDER_EPOCH } from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	injectM0M1Pi,
	materializeM0Pi,
	materializeM0PiWithRetry,
	mustMaterializePi,
	renderM0Pi,
	renderM1Pi,
} from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

function user(text: string, timestamp = 1) {
	return { role: "user" as const, content: text, timestamp };
}

function assistant(callIds: string[], text = "") {
	return {
		role: "assistant" as const,
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...callIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: {},
			})),
		],
		timestamp: 1,
	};
}

function result(toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text: `out-${toolCallId}` }],
		isError: false,
		timestamp: 1,
	};
}

describe("workspace memory sharing (mini)", () => {
	it("renders only compartments in Pi m[0] — workspace memory sharing is removed", () => {
		const db = createTestDb();
		const dir = mkdtempSync(join(tmpdir(), "mc-pi-share-"));
		try {
			appendCompartments(db, "pi-share", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "Setup",
					content: "Compacted Pi setup",
				},
			]);
			const state = {
				sessionId: "pi-share",
				projectIdentity: "git:own",
				projectDirectory: dir,
			};

			const m0 = renderM0Pi(state, db, "");
			expect(m0).toContain("## 1-2 · Setup");
			expect(m0).not.toContain("<project-memory>");
			expect(m0).not.toContain("<user-profile>");

			const messages = [userMessage("hello")];
			const result = injectM0M1Pi(state, db, messages);
			expect(result.memoryCount).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("trimPiMessagesToBoundary", () => {
	it("sweeps non-contiguous toolResults whose assistant toolCall was trimmed", () => {
		const messages = [
			assistant(["call-a"]),
			user("interleaved"),
			result("call-a"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "u1", "r", "u2"],
			"a",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect((messages[0] as { content: string }).content).toBe("interleaved");
	});

	it("sweeps split multi-toolCall results after an intervening user", () => {
		const messages = [
			assistant(["call-a", "call-b"]),
			user("gap"),
			result("call-a"),
			result("call-b"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "gap", "ra", "rb", "keep"],
			"a",
		);

		expect(removed).toBe(3);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("sweeps kept assistant toolCalls when their toolResult was trimmed", () => {
		const messages = [
			user("old"),
			result("call-a"),
			assistant(["call-a"]),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["u", "r", "a", "keep"],
			"r",
		);

		expect(removed).toBe(3);
		expect(messages).toEqual([user("keep")]);
	});

	it("resolves a synth-user-* cutoff to the underlying real toolResult entry id", () => {
		// A compartment ending on a folded-toolResult boundary carries
		// endMessageId = `synth-user-<realToolResultEntryId>`. The live array has
		// no message with that synthetic id — only the real toolResult (entry id
		// "tr-real"). Pre-fix, the cutoff never matched and NOTHING was trimmed
		// (history duplicated -> overflow). The fix strips the prefix and matches
		// the real toolResult, then the orphan sweep removes its paired assistant.
		const messages = [
			assistant(["call-a"]),
			result("call-a"),
			assistant([], "next turn"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "tr-real", "a2", "keep"],
			"synth-user-tr-real",
		);

		// toolResult "tr-real" (cutoff) + its paired assistant "call-a" (orphan
		// sweep) are removed; the later turn + keep survive.
		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
		expect((messages[1] as { content: string }).content).toBe("keep");
	});

	it("returns 0 (no spurious trim) when a synth-user-* cutoff has no matching real entry", () => {
		const messages = [assistant(["call-a"]), user("keep")];
		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "keep"],
			"synth-user-nonexistent",
		);
		expect(removed).toBe(0);
		expect(messages.length).toBe(2);
	});

	it("does not over-remove a later kept tool pair that reuses a trimmed callId", () => {
		const messages = [
			assistant(["reused"]),
			result("reused"),
			user("between turns"),
			assistant(["reused"]),
			result("reused"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a1", "r1", "u1", "a2", "r2", "u2"],
			"a1",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect((messages[3] as { content: string }).content).toBe("keep");
	});

	it("renders frozen compartment snapshot without m[0]/m[1] duplication", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-frozen-cp-profile-"));
		try {
			const state = piState("ses-pi-frozen-cp-profile", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Frozen",
					content: "U: old turn\nold compartment body",
				},
			]);
			const frozenCompartments = getCompartments(db, state.sessionId);

			appendCompartments(db, state.sessionId, [
				{
					sequence: 2,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-2",
					endMessageId: "entry-2",
					title: "Concurrent",
					content: "U: new turn\nnew compartment body",
				},
			]);

			const m0 = renderM0Pi(state, db, "", 1, [], frozenCompartments);
			const m1 = renderM1Pi(state, db, {
				maxCompartmentSeq: 1,
				maxMemoryId: 0,
				maxMutationId: 0,
				maxMemoryMutationId: 0,
				projectMemoryEpoch: 0,
				projectUserProfileVersion: 0,
				projectDocsHash: "",
				sessionFactsVersion: 0,
				materializedAt: 0,
				upgradeState: "",
				lastBaselineEndMessageId: "entry-1",
			});

			expect(m0).toContain("old compartment body");
			expect(m0).not.toContain("new compartment body");
			expect(m1).toContain("new compartment body");
			expect(m1).not.toContain("old compartment body");
		} finally {
			closeQuietly(db);
		}
	});
});

function piState(sessionId: string, cwd: string) {
	return {
		sessionId,
		projectIdentity: resolveProjectIdentity(cwd),
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
	};
}

describe("injectM0M1Pi memory feature gate", () => {
	it("never renders project memories into m[0]/m[1] — memory is removed in mini", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-memgate-"));
		try {
			const base = piState("ses-pi-memgate", cwd);
			// A compartment (history) MUST still render.
			appendCompartments(db, base.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);

			const off = [userMessage("hello", 10)];
			injectM0M1Pi(
				{ ...base, memoryEnabled: false },
				db,
				off as never,
				undefined,
				true,
			);
			const offM0 = textOf(off[0] as never);
			expect(offM0).not.toContain("<project-memory");
			expect(offM0).toContain("compartment body present");

			// memoryEnabled=true also renders no memory (removed from the live path).
			const on = [userMessage("hello", 10)];
			injectM0M1Pi(
				{ ...base, memoryEnabled: true },
				db,
				on as never,
				undefined,
				true,
			);
			expect(textOf(on[0] as never)).not.toContain("<project-memory");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi", () => {
	it("renders first-pass m[0] with no inner content and m[1] placeholder", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-"));
		try {
			const messages = [userMessage("hello", 10)];
			injectM0M1Pi(piState("ses-pi-empty", cwd), db, messages as never);

			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toBe(
				"<session-history-since>(no new content since last materialization)</session-history-since>",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("gates project docs block and hash with injectDocs=false", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-docs-gate-"));
		try {
			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# PI_FLAG_OFF_ARCH_DOCS\nArchitecture bytes must stay out.\n",
			);
			writeFileSync(
				join(cwd, "STRUCTURE.md"),
				"# PI_FLAG_OFF_STRUCTURE_DOCS\nStructure bytes must stay out.\n",
			);
			const state = { ...piState("ses-pi-docs-off", cwd), injectDocs: false };

			const first = [userMessage("hello", 10)];
			const firstResult = injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			expect(firstResult.m0Materialized).toBe(true);
			expect(firstM0).not.toContain("<project-docs>");
			expect(firstM0).not.toContain("PI_FLAG_OFF_ARCH_DOCS");
			expect(firstM0).not.toContain("PI_FLAG_OFF_STRUCTURE_DOCS");
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0ProjectDocsHash,
			).toBe("");
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});

			const second = [userMessage("hello again", 11)];
			const secondResult = injectM0M1Pi(
				state,
				db,
				second as never,
				undefined,
				false,
			);

			expect(secondResult.m0Materialized).toBe(false);
			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);

			const enabledState = piState("ses-pi-docs-on", cwd);
			const enabled = [userMessage("hello docs", 12)];
			injectM0M1Pi(enabledState, db, enabled as never);
			expect(textOf(enabled[0] as never)).toContain("<project-docs>");
			expect(textOf(enabled[0] as never)).toContain("PI_FLAG_OFF_ARCH_DOCS");
			expect(textOf(enabled[0] as never)).toContain(
				"PI_FLAG_OFF_STRUCTURE_DOCS",
			);
			expect(
				mustMaterializePi({ ...enabledState, injectDocs: false }, db),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("replays byte-stable cached m[0]/m[1] for identical state", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-stable-"));
		try {
			const state = piState("ses-pi-stable", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never);

			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);
		} finally {
			closeQuietly(db);
		}
	});

	it("folds a legacy render epoch once, then replays m[0]/m[1] byte-identically", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-render-epoch-"));
		try {
			const state = piState("ses-pi-render-epoch", cwd);
			injectM0M1Pi(state, db, [userMessage("first", 10)] as never);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_upgrade_state = ? WHERE session_id = ?",
			).run(
				Buffer.from("<session-history>legacy renderer bytes</session-history>"),
				"pi-m0m1-v2:ready",
				state.sessionId,
			);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "compartment_render_epoch",
			});
			const foldedMessages = [userMessage("same", 11)];
			const folded = injectM0M1Pi(state, db, foldedMessages as never);
			const foldedM0 = textOf(foldedMessages[0] as never);
			const foldedM1 = textOf(foldedMessages[1] as never);
			const replay1 = [userMessage("same", 11)];
			const replay2 = [userMessage("same", 11)];
			const replayResult1 = injectM0M1Pi(state, db, replay1 as never);
			const replayResult2 = injectM0M1Pi(state, db, replay2 as never);

			expect(folded.m0Materialized).toBe(true);
			expect(folded.m0Reason).toBe("compartment_render_epoch");
			expect(replayResult1.m0Materialized).toBe(false);
			expect(replayResult2.m0Materialized).toBe(false);
			expect(textOf(replay1[0] as never)).toBe(foldedM0);
			expect(textOf(replay2[0] as never)).toBe(foldedM0);
			expect(textOf(replay1[1] as never)).toBe(foldedM1);
			expect(textOf(replay2[1] as never)).toBe(foldedM1);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0UpgradeState,
			).toContain(COMPARTMENT_RENDER_EPOCH);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes m[0] when a LEGACY compartment appears (upgrade_state HARD flip)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-compartment-"));
		try {
			const state = piState("ses-pi-compartment", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			expect(textOf(first[0] as never)).not.toContain("Compacted setup");

			// A LEGACY compartment (no p1 tier → legacy=1) flips upgrade_state
			// "ready"→"legacy", which is a genuine HARD trigger (the session now
			// needs /ctx-session-upgrade). This is NOT the new-compartment path — a
			// v2 compartment (with p1) is a SOFT m[1] delta and does NOT re-
			// materialize m[0] (see the SOFT-delta test below). Asserting the legacy
			// HARD path here keeps the upgrade-detection contract pinned.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never, ["entry-1"]);

			// m[0] re-materialized and now carries the compartment heading; the
			// body is present because the U: line keeps the legacy row at P3.
			expect(textOf(second[0] as never)).toContain("## 1-1 · Setup");
			expect(textOf(second[0] as never)).toContain("Compacted setup");
			expect(textOf(second[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("SOFT pass: new v2 compartment surfaces in m[1] WITHOUT re-materializing m[0], raw messages trimmed", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-soft-delta-"));
		try {
			const state = piState("ses-pi-soft-delta", cwd);
			// First v2 compartment (p1 present → legacy=0, upgrade_state stays
			// "ready"). Materialize the m[0] baseline.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "First",
					content: "U: first turn\nfirst compartment body",
					p1: "U: first turn\nfirst compartment body",
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, ["entry-0"]);
			expect(r0.m0Materialized).toBe(true);
			const baselineM0 = textOf(firstPass[0] as never);
			expect(baselineM0).toContain("first compartment body");

			// Historian publishes a SECOND v2 compartment (the delta). This is the
			// exact scenario the taxonomy fix targets: it MUST ride m[1], not fold
			// m[0].
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Delta",
					content: "U: second turn\nsecond compartment body",
					p1: "U: second turn\nsecond compartment body",
				},
			]);

			// Cache-busting pass (history refresh): recomputeM1ThisPass=true.
			const secondPass = [
				userMessage("covered-0", 10), // entry-0 → already baseline
				userMessage("covered-1", 11), // entry-1 → new compartment, must trim
				userMessage("keep", 12), // live tail → must survive
			];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-0", "entry-1", "keep"],
				true,
			);

			// (a) m[0] NOT re-materialized — SOFT, not HARD.
			expect(r1.m0Materialized).toBe(false);
			// (b) m[0] bytes byte-identical to the baseline (the whole point of the
			// split: the stable prefix stays cached).
			const m0 = textOf(secondPass[0] as never);
			expect(m0).toBe(baselineM0);
			expect(m0).not.toContain("second compartment body");
			// (c) new compartment surfaces in m[1].
			expect(textOf(secondPass[1] as never)).toContain(
				"second compartment body",
			);
			// (d) raw messages through the new compartment boundary (entry-1) are
			// trimmed (no duplication) while the live tail survives.
			expect(r1.skippedVisibleMessages).toBe(2);
			expect(textOf(secondPass[secondPass.length - 1] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with NULL required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-marker-"));
		try {
			const state = piState("ses-pi-null-marker", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const second = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, second as never);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(textOf(second[0] as never)).toContain("<session-history>");
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps legacy cached max seq 0 when a real seq-0 compartment exists", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-legacy-zero-real-"));
		try {
			const state = piState("ses-pi-legacy-zero-real", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Seq Zero",
					content: "U: first turn\nseq zero body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, ["entry-0"]);

			// Legacy rows persisted 0 both for empty snapshots and for a real seq-0
			// baseline. With a compartment present, 0 is unambiguous and must remain
			// the cached watermark, not be reinterpreted as the empty -1 sentinel.
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never, ["entry-0"]);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toContain("seq zero body");
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("normalizes legacy cached max seq 0 to empty only with zero compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-legacy-zero-empty-"));
		try {
			const state = piState("ses-pi-legacy-zero-empty", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = 0 WHERE session_id = ?",
			).run(state.sessionId);

			expect(getCompartments(db, state.sessionId)).toHaveLength(0);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with any partial required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-partial-marker-"));
		try {
			const state = piState("ses-pi-partial-marker", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_materialized_at = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes instead of reusing cached m[0] when compartment boundary is NULL", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-boundary-"));
		try {
			const state = piState("ses-pi-null-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Boundary",
					content: "U: boundary turn\nboundary body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, ["entry-0"]);
			db.prepare(
				"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const messages = [userMessage("covered", 10), userMessage("keep", 11)];
			const result = injectM0M1Pi(state, db, messages as never, [
				"entry-0",
				"keep",
			]);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("reuses cached m[0] (no rematerialize loop) when the compartment is legitimately boundaryless", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-boundary-"));
		try {
			const state = piState("ses-pi-empty-boundary", cwd);
			// A compartment with EMPTY end_message_id is a legitimate state (schema
			// default ''; OpenCode degrades to no-trim). Materialize persists a null
			// boundary for it — which must NOT then be treated as stale-cache and
			// force a rematerialize every pass.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "",
					endMessageId: "",
					title: "Boundaryless",
					content: "U: turn\nbody",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, []);

			// Cached boundary is null (the compartment has no usable end id), and the
			// LIVE snapshot is also boundaryless → cache is valid, not stale.
			expect(mustMaterializePi(state, db).value).toBe(false);

			// And a second injection pass reuses the cache (no materialize) and
			// degrades to no-trim rather than looping.
			const pass1Messages = [userMessage("hello", 10)];
			const result1 = injectM0M1Pi(state, db, pass1Messages as never, []);
			expect(result1.m0Materialized).toBe(false);
			expect(result1.skippedVisibleMessages).toBe(0);

			const pass2Messages = [userMessage("hello", 10)];
			const result2 = injectM0M1Pi(state, db, pass2Messages as never, []);
			expect(result2.m0Materialized).toBe(false);
			expect(result2.m0Reason).toBeNull();

			// Cache-stability invariant: a boundaryless session must render
			// BYTE-IDENTICAL m[0]/m[1] across consecutive reuse passes (no
			// materialize-vs-reuse oscillation). Compare the actual injected
			// synthetic-prefix text, not just the materialized flag.
			expect(textOf(pass2Messages[0] as never)).toBe(
				textOf(pass1Messages[0] as never),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries instead of losing seq-0 compartment published during materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-seq0-race-"));
		try {
			const state = piState("ses-pi-seq0-race", cwd);
			const originalExec = db.exec.bind(db);
			let injectedRace = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedRace) {
					injectedRace = true;
					appendCompartments(db, state.sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 1,
							startMessageId: "entry-0",
							endMessageId: "entry-0",
							title: "First",
							content: "U: first turn\nseq zero body",
						},
					]);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const { m0, snapshotMarkers } = materializeM0PiWithRetry(state, db);

			expect(injectedRace).toBe(true);
			expect(snapshotMarkers.maxCompartmentSeq).toBe(0);
			expect(m0).toContain("seq zero body");
		} finally {
			closeQuietly(db);
		}
	});

	it("trims against the frozen cached boundary instead of live rewritten compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-frozen-boundary-"));
		try {
			const state = piState("ses-pi-frozen-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-end",
					endMessageId: "old-end",
					title: "Frozen",
					content: "U: old turn\nfrozen body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE compartments SET end_message_id = ? WHERE session_id = ? AND sequence = 0",
			).run("too-far", state.sessionId);

			const messages = [
				userMessage("old visible", 10),
				userMessage("must stay", 11),
				userMessage("keep", 12),
			];
			const result = injectM0M1Pi(state, db, messages as never, [
				"old-end",
				"too-far",
				"keep",
			]);

			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("must stay");
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE error exposes only SQLITE_BUSY code", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-code-"));
		try {
			const state = piState("ses-pi-begin-busy-code", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy Code",
					content: "U: busy code turn\nbusy code fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					const error = new Error("writer unavailable") as Error & {
						code: string;
					};
					error.code = "SQLITE_BUSY";
					throw error;
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
			expect(textOf(messages[1] as never)).not.toContain(
				"busy code fallback body",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE is busy", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-"));
		try {
			const state = piState("ses-pi-begin-busy", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy",
					content: "U: busy turn\nbusy fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					throw new Error("SQLITE_BUSY: database is locked");
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
			expect(textOf(messages[1] as never)).not.toContain("busy fallback body");
		} finally {
			closeQuietly(db);
		}
	});

	it("replays byte-identical m[1] on defer passes (compartment-only)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-additive-stable-"));
		try {
			const state = piState("ses-pi-m1-additive-stable", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "large baseline",
					content: "baseline ".repeat(300),
				},
			]);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			const initialM1 = textOf(first[1] as never);

			const deferOne = [userMessage("defer one", 11)];
			injectM0M1Pi(state, db, deferOne as never, undefined, false);
			const deferTwo = [userMessage("defer two", 12)];
			injectM0M1Pi(state, db, deferTwo as never, undefined, false);

			expect(textOf(deferOne[1] as never)).toBe(initialM1);
			expect(textOf(deferTwo[1] as never)).toBe(initialM1);

			const bust = [userMessage("bust", 13)];
			injectM0M1Pi(state, db, bust as never, undefined, true);
			// Mini: m[1] carries only new compartments — never a memory delta.
			expect(textOf(bust[1] as never)).not.toContain("<new-memories>");
		} finally {
			closeQuietly(db);
		}
	});

	it("renders no memory archive/update deltas on cache-busting passes", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-archive-delta-"));
		try {
			const state = piState("ses-pi-m1-archive-delta", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "large baseline",
					content: "baseline ".repeat(300),
				},
			]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);

			const defer = [userMessage("defer", 11)];
			injectM0M1Pi(state, db, defer as never, undefined, false);
			expect(textOf(defer[1] as never)).not.toContain("<memory-updates>");

			const bust = [userMessage("bust", 12)];
			injectM0M1Pi(state, db, bust as never, undefined, true);
			expect(textOf(bust[1] as never)).not.toContain("<memory-updates>");
		} finally {
			closeQuietly(db);
		}
	});

	it("renders no memory-updates for trimmed or updated memories", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-trimmed-delta-"));
		try {
			const state = {
				...piState("ses-pi-m1-trimmed-delta", cwd),
				injectionBudgetTokens: 1,
			};
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);

			const bust = [userMessage("bust", 11)];
			injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(textOf(bust[1] as never)).not.toContain("<memory-updates>");
		} finally {
			closeQuietly(db);
		}
	});

	it("reconcile rematerialization omits memory-updates (compartment-only)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-reconcile-delta-"));
		try {
			const state = piState("ses-pi-m1-reconcile-delta", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "baseline",
					content: "baseline compartment",
				},
			]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[1] as never)).not.toContain("<memory-updates>");
		} finally {
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS rolls back and replays a sibling cached m1 on marker mismatch", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_max_memory_id = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						Buffer.from(
							`<session-history>${"baseline ".repeat(300)}</session-history>`,
							"utf8",
						),
						99,
						Buffer.from("sibling cached m1", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[1] as never)).toBe("sibling cached m1");
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS rejects byte-different m[0] even when non-doc markers match", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-bytes-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas-bytes", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			const siblingM0 = Buffer.from(
				`<session-history>${"byte mismatch ".repeat(300)}</session-history>`,
				"utf8",
			);
			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						siblingM0,
						Buffer.from("sibling cached pi m1 byte mismatch", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[0] as never)).toBe(siblingM0.toString("utf8"));
			expect(textOf(bust[1] as never)).toBe(
				"sibling cached pi m1 byte mismatch",
			);
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS treats docs-hash-only marker drift as a match", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-docs-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas-docs", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			const baselineM0 = textOf(first[0] as never);
			let changedDocsMarker = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !changedDocsMarker) {
					changedDocsMarker = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_project_docs_hash = ? WHERE session_id = ?",
					).run("docs-only-marker-drift", state.sessionId);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(changedDocsMarker).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[0] as never)).toBe(baselineM0);
			// Mini: m[1] never renders memory deltas.
			expect(textOf(bust[1] as never)).not.toContain("<new-memories>");
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});
});

describe("renderM0Pi sibling-block layout (mini)", () => {
	it("renders only project-docs + decayed compartments — no memory/user-profile blocks", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-siblings-"));
		try {
			const state = piState("ses-pi-siblings", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);

			const m0 = renderM0Pi(state, db);

			// Mini: m[0] renders only <session-history> (compartments); the
			// <project-memory> / <user-profile> / <memory-mural> sibling blocks
			// are removed from the live path.
			expect(m0).toContain("<session-history>");
			expect(m0).toContain("Compacted setup");
			expect(m0).not.toContain("<project-memory>");
			expect(m0).not.toContain("<user-profile>");
			expect(m0).not.toContain("<memory-mural>");
		} finally {
			closeQuietly(db);
		}
	});

	it("materializeM0Pi keeps maxMemoryId watermark at 0 (no memory rendering)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-watermark-"));
		try {
			const state = piState("ses-pi-watermark", cwd);

			const { snapshotMarkers } = materializeM0Pi(state, db);

			expect(snapshotMarkers.maxMemoryId).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD fold keeps m[0] byte-identical across folds (no memory rendering)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-d16c-"));
		try {
			const state = piState("ses-pi-d16c", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "Compacted setup",
				},
			]);

			const foldAt = 10_000;
			let nowCalls = 0;
			const realNow = Date.now;
			Date.now = () => {
				nowCalls += 1;
				return nowCalls === 1 ? foldAt : 99_000;
			};

			try {
				state.hardSignals = {
					systemHash: "fold-a",
					modelKey: "model-v1",
					cacheExpired: false,
					lastResponseTime: 0,
				};
				const first = materializeM0Pi(state, db);
				expect(first.snapshotMarkers.materializedAt).toBe(foldAt);

				nowCalls = 0;
				state.hardSignals = {
					systemHash: "fold-b",
					modelKey: "model-v1",
					cacheExpired: false,
					lastResponseTime: 0,
				};
				const second = materializeM0Pi(state, db);
				// Decay-rendered compartments are deterministic — the history
				// block is byte-identical across folds.
				expect(second.m0).toBe(first.m0);
			} finally {
				Date.now = realNow;
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("mustMaterializePi — SOFT/HARD taxonomy (parity with OpenCode)", () => {
	const baseHard = {
		systemHash: "sys-v1",
		modelKey: "anthropic/opus",
		cacheExpired: false,
		lastResponseTime: 0,
	};

	function compartment(seq: number, body: string) {
		return {
			sequence: seq,
			startMessage: seq,
			endMessage: seq,
			startMessageId: `entry-${seq}`,
			endMessageId: `entry-${seq}`,
			title: `T${seq}`,
			content: body,
			p1: body,
		};
	}

	it("does NOT materialize m[0] on a new compartment (it rides m[1])", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-newcomp-"));
		try {
			const state = {
				...piState("ses-pi-tax-newcomp", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			// Publish a new compartment — the routine historian publish.
			appendCompartments(db, state.sessionId, [compartment(1, "Bravo")]);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a model change folds m[0]", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-"));
		try {
			const state = {
				...piState("ses-pi-tax-model", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const switched = {
				...state,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			expect(mustMaterializePi(switched, db)).toEqual({
				value: true,
				reason: "model_change",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a system-hash change folds m[0]", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-sys-"));
		try {
			const state = {
				...piState("ses-pi-tax-sys", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			expect(mustMaterializePi(changed, db)).toEqual({
				value: true,
				reason: "system_hash",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("lazy-adopts a NULL cached project marker without a no-switch HARD fold", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-project-null-a-"));
		const cwdB = mkdtempSync(join(tmpdir(), "pi-tax-project-null-b-"));
		try {
			const state = {
				...piState("ses-pi-tax-project-null", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, ["entry-0"]);
			const baselineM0 = textOf(first[0] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_project_identity = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const noSwitch = [userMessage("same project", 11)];
			const noSwitchResult = injectM0M1Pi(state, db, noSwitch as never, [
				"entry-0",
			]);

			expect(noSwitchResult.m0Materialized).toBe(false);
			expect(noSwitchResult.m0Reason).not.toBe("first_render");
			expect(noSwitchResult.m0Reason).not.toBe("project_change");
			expect(textOf(noSwitch[0] as never)).toBe(baselineM0);
			expect(
				db
					.prepare(
						"SELECT cached_m0_project_identity FROM session_meta WHERE session_id = ?",
					)
					.get(state.sessionId),
			).toEqual({ cached_m0_project_identity: state.projectIdentity });

			const switched = {
				...piState(state.sessionId, cwdB),
				hardSignals: baseHard,
			};
			expect(mustMaterializePi(switched, db)).toEqual({
				value: true,
				reason: "project_change",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("HARD: a genuine same-session project switch folds exactly once, then stabilizes", () => {
		const db = createTestDb();
		const cwdA = mkdtempSync(join(tmpdir(), "pi-tax-project-a-"));
		const cwdB = mkdtempSync(join(tmpdir(), "pi-tax-project-b-"));
		try {
			const stateA = {
				...piState("ses-pi-tax-project-switch", cwdA),
				hardSignals: baseHard,
			};
			appendCompartments(db, stateA.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-a",
					endMessageId: "entry-a",
					title: "Project A slice",
					content: "Project A compartment content.",
				},
			]);
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(stateA, db, first as never, undefined, true);
			expect(textOf(first[0] as never)).toContain("## 1-1 · Project A slice");

			const stateB = {
				...piState(stateA.sessionId, cwdB),
				hardSignals: baseHard,
			};

			const switched = [userMessage("after cd", 11)];
			const switchedResult = injectM0M1Pi(
				stateB,
				db,
				switched as never,
				undefined,
				true,
			);
			expect(switchedResult.m0Materialized).toBe(true);
			expect(switchedResult.m0Reason).toBe("project_change");

			const stable = [userMessage("after cd stable", 12)];
			const stableResult = injectM0M1Pi(
				stateB,
				db,
				stable as never,
				undefined,
				false,
			);
			expect(stableResult.m0Materialized).toBe(false);
			expect(stableResult.m0Reason).toBeNull();
			expect(textOf(stable[0] as never)).toBe(textOf(switched[0] as never));
		} finally {
			rmSync(cwdA, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("model and system changes materialize with classified reasons, not first_render", () => {
		const db = createTestDb();
		const cwdModel = mkdtempSync(join(tmpdir(), "pi-tax-model-reason-"));
		const cwdSystem = mkdtempSync(join(tmpdir(), "pi-tax-system-reason-"));
		try {
			const modelState = {
				...piState("ses-pi-tax-model-reason", cwdModel),
				hardSignals: baseHard,
			};
			injectM0M1Pi(modelState, db, [userMessage("hi", 10)] as never);
			const modelChanged = {
				...modelState,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			const modelPass = [userMessage("model", 11)];
			const modelResult = injectM0M1Pi(modelChanged, db, modelPass as never);
			expect(modelResult.m0Materialized).toBe(true);
			expect(modelResult.m0Reason).toBe("model_change");
			expect(modelResult.m0Reason).not.toBe("first_render");

			const systemState = {
				...piState("ses-pi-tax-system-reason", cwdSystem),
				hardSignals: baseHard,
			};
			injectM0M1Pi(systemState, db, [userMessage("hi", 10)] as never);
			const systemChanged = {
				...systemState,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const systemPass = [userMessage("system", 11)];
			const systemResult = injectM0M1Pi(systemChanged, db, systemPass as never);
			expect(systemResult.m0Materialized).toBe(true);
			expect(systemResult.m0Reason).toBe("system_hash");
			expect(systemResult.m0Reason).not.toBe("first_render");
		} finally {
			rmSync(cwdModel, { recursive: true, force: true });
			rmSync(cwdSystem, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("an empty current HARD signal is never treated as a change", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-empty-"));
		try {
			const state = {
				...piState("ses-pi-tax-empty", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const unknown = {
				...state,
				hardSignals: {
					systemHash: "",
					modelKey: "",
					cacheExpired: false,
					lastResponseTime: 0,
				},
			};
			expect(mustMaterializePi(unknown, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT materialize m[0] on a project docs hash change", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-docs-soft-"));
		try {
			const state = {
				...piState("ses-pi-tax-docs-soft", cwd),
				hardSignals: baseHard,
			};
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi docs\n");
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				undefined,
				true,
			);

			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# New Pi docs\n");

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("folds current project docs on the next natural HARD materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-docs-hard-"));
		try {
			const state = {
				...piState("ses-pi-tax-docs-hard", cwd),
				hardSignals: baseHard,
			};
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi architecture\n");
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			expect(textOf(first[0] as never)).toContain("Old Pi architecture");

			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# Updated Pi architecture\nFresh Pi docs folded on hard bust.\n",
			);
			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const second = [userMessage("hi again", 11)];
			const result = injectM0M1Pi(
				changed,
				db,
				second as never,
				undefined,
				true,
			);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("system_hash");
			expect(textOf(second[0] as never)).toContain("Updated Pi architecture");
			expect(textOf(second[0] as never)).toContain(
				"Fresh Pi docs folded on hard bust.",
			);
			expect(textOf(second[0] as never)).not.toContain("Old Pi architecture");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi m[1]-rendered coverage watermark (marker-drain liveness)", () => {
	it("reports the m[1] delta watermark on a fresh recompute and null on pure replay", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-"));
		try {
			const state = piState("ses-pi-m1-coverage", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "First",
					content: "first compartment body",
					p1: "first compartment body",
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, ["entry-0"]);
			expect(r0.m0Materialized).toBe(true);
			// The full materialization folds the compartment into m[0], so the
			// m[0] boundary covers it and the m[1] delta carries nothing beyond
			// the m[0] snapshot watermark.
			expect(r0.renderedBoundary.endMessageId).toBe("entry-0");
			expect(r0.m1RenderedCoverage).toBeNull();

			// Historian publishes a SECOND compartment — an m[1] delta; m[0] is
			// NOT re-materialized (new_compartment is not a HARD trigger).
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Delta",
					content: "second compartment body",
					p1: "second compartment body",
				},
			]);

			// Cache-busting pass: the soft refresh recomputes m[1] from the same
			// compartment snapshot and certifies the m[1] delta watermark at the
			// new compartment. (With a non-empty baseline the soft refresh also
			// advances the persisted trim boundary string, so the m[0] arm moves
			// too; the empty-baseline test below is the shape where ONLY the m[1]
			// field certifies coverage.)
			const secondPass = [
				userMessage("covered-0", 10),
				userMessage("covered-1", 11),
				userMessage("keep", 12),
			];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-0", "entry-1", "keep"],
				true,
			);
			expect(r1.m0Materialized).toBe(false);
			expect(r1.contentionExhausted).toBe(false);
			expect(r1.m1RenderedCoverage).toEqual({
				endMessageId: "entry-1",
				ordinal: 2,
			});

			// Pure replay pass (recomputeM1ThisPass=false): the served bytes
			// were rendered by an earlier pass, so no fresh coverage may be
			// certified — the field must be null.
			const thirdPass = [
				userMessage("covered-0", 10),
				userMessage("covered-1", 11),
				userMessage("keep", 12),
			];
			const r2 = injectM0M1Pi(
				state,
				db,
				thirdPass as never,
				["entry-0", "entry-1", "keep"],
				false,
			);
			expect(r2.m0Materialized).toBe(false);
			expect(r2.m1RenderedCoverage).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("certifies coverage from the m[1] delta when the m[0] baseline is empty (the liveness-gap shape)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-empty-"));
		try {
			const state = piState("ses-pi-m1-coverage-empty", cwd);
			// Materialize with NO compartments: the empty m[0] baseline whose
			// snapshot markers carry no compartment boundary at all.
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never);
			expect(r0.m0Materialized).toBe(true);
			expect(r0.renderedBoundary).toEqual({
				endMessageId: null,
				ordinal: null,
			});
			expect(r0.m1RenderedCoverage).toBeNull();

			// A normal publication lands (three compartments, mirroring the
			// diagnosis: seq 0:1-2, 1:3-4, 2:5-7). It renders into m[1] only.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "A",
					content: "chunk a",
					p1: "chunk a",
				},
				{
					sequence: 1,
					startMessage: 3,
					endMessage: 4,
					startMessageId: "entry-3",
					endMessageId: "entry-4",
					title: "B",
					content: "chunk b",
					p1: "chunk b",
				},
				{
					sequence: 2,
					startMessage: 5,
					endMessage: 7,
					startMessageId: "entry-5",
					endMessageId: "entry-7",
					title: "C",
					content: "chunk c",
					p1: "chunk c",
				},
			]);

			const secondPass = [userMessage("hello", 10), userMessage("tail", 12)];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-1", "keep"],
				true,
			);
			expect(r1.m0Materialized).toBe(false);
			// The m[0] arm still reads <none>, so it cannot by itself certify
			// coverage for the pending marker…
			expect(r1.renderedBoundary).toEqual({
				endMessageId: null,
				ordinal: null,
			});
			// …while the fresh m[1] delta certifies coverage up to the latest
			// published compartment, so a pending marker at ordinal 7 covers.
			expect(r1.m1RenderedCoverage).toEqual({
				endMessageId: "entry-7",
				ordinal: 7,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("soft m[1] refresh sibling-fallback reports null coverage even with a newer live compartment", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-sibling-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-coverage-sibling", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);

			// A newer compartment lands in the live snapshot. A naive coverage
			// derivation from live DB rows would certify it — but the stale
			// sibling bytes served below were rendered BEFORE it existed.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "New",
					content: "new compartment body",
					p1: "new compartment body",
				},
			]);

			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_max_memory_id = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						Buffer.from(
							`<session-history>${"baseline ".repeat(300)}</session-history>`,
							"utf8",
						),
						99,
						Buffer.from("sibling cached m1", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[1] as never)).toBe("sibling cached m1");
			// The sibling-fallback leaves contentionExhausted FALSE (recomputed=
			// false), so the existing contention veto does NOT catch it — the
			// coverage field itself must be null to keep the deferred drain
			// signal armed for the next fresh render.
			expect(result.contentionExhausted).toBe(false);
			expect(result.m1RenderedCoverage).toBeNull();
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});
});
