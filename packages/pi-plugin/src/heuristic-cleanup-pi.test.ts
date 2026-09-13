import { describe, expect, it } from "bun:test";
import {
	getActiveTagsBySession,
	getTagsBySession,
	insertTag,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyPendingOperations } from "@magic-context/core/hooks/magic-context/apply-operations";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import { createTestDb, userMessage } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

function tagMessages(
	sessionId: string,
	db: ReturnType<typeof createTestDb>,
	messages: unknown[],
) {
	const tagger = createTagger();
	tagger.initFromDb(sessionId, db);
	const transcript = createPiTranscript(
		messages,
		sessionId,
		messages.map((_, index) => `entry-${index}`),
	);
	const tagged = tagTranscript(sessionId, transcript, tagger, db);
	return { tagger, transcript, targets: tagged.targets };
}

describe("applyPiHeuristicCleanup", () => {
	it("keeps identical read-tool fingerprints distinct across assistant owners", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-cross-owner";
			const messages = [
				userMessage("read once", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
				userMessage("read again", 3),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 4,
				},
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(
				sessionId,
				db,
				targets,
				messages,
				{
					protectedTags: 0,
				},
				undefined,
				(_message, index) => `entry-${index}`,
			);
			transcript.commit();

			expect(result.deduplicatedTools).toBe(0);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.toolOwnerMessageId, tag.status]),
			).toEqual([
				["read-call-a", "entry-1", "active"],
				["read-call-b", "entry-3", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("deduplicates same-owner parallel read calls with identical arguments", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-same-owner";
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(
				sessionId,
				db,
				targets,
				messages,
				{
					protectedTags: 0,
				},
				undefined,
				(_message, index) => `entry-${index}`,
			);
			transcript.commit();

			expect(result.deduplicatedTools).toBe(1);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.toolOwnerMessageId, tag.status]),
			).toEqual([
				["read-call-a", "entry-1", "dropped"],
				["read-call-b", "entry-1", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not count an absent dedup target as a confirmed mutation", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-dedup-absent";
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
			];
			const { targets } = tagMessages(sessionId, db, messages);
			const oldTag = getTagsBySession(db, sessionId).find(
				(tag) => tag.messageId === "read-call-a",
			);
			if (!oldTag) throw new Error("missing old tag");
			targets.delete(oldTag.tagNumber);

			const result = applyPiHeuristicCleanup(
				sessionId,
				db,
				targets,
				messages,
				{
					protectedTags: 0,
				},
				undefined,
				(_message, index) => `entry-${index}`,
			);

			expect(result.deduplicatedTools).toBe(0);
			expect(
				getTagsBySession(db, sessionId).find(
					(tag) => tag.tagNumber === oldTag.tagNumber,
				)?.status,
			).toBe("dropped");
		} finally {
			closeQuietly(db);
		}
	});

	function makePiDropTarget(): TagTarget {
		const state = { present: true };
		return {
			setContent: () => false,
			drop: () => {
				if (!state.present) return "absent";
				state.present = false;
				return "removed";
			},
			canDrop: () => state.present,
		};
	}

	it("uses the post-pending-op active tag set for emergency planning", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-floor-recompute";
			const targets = new Map<number, TagTarget>();
			for (let tag = 1; tag <= 4; tag++) {
				insertTag(db, sessionId, `tool-${tag}`, "tool", 4000, tag, 0, "bash");
				targets.set(tag, makePiDropTarget());
			}
			queuePendingOp(db, sessionId, 1, "drop", 1);
			queuePendingOp(db, sessionId, 2, "drop", 2);

			applyPendingOperations(sessionId, db, targets, 0);
			const activeAfterPending = getActiveTagsBySession(db, sessionId);
			applyPiHeuristicCleanup(
				sessionId,
				db,
				targets,
				[],
				{
					protectedTags: 0,
					emergency: { currentTotalInputTokens: 7000, ceilingTokens: 6000 },
				},
				activeAfterPending,
				(_message, index) => `entry-${index}`,
			);

			expect(
				getTagsBySession(db, sessionId).map((tag) => [
					tag.tagNumber,
					tag.status,
				]),
			).toEqual([
				[1, "dropped"],
				[2, "dropped"],
				[3, "active"],
				[4, "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});
});
