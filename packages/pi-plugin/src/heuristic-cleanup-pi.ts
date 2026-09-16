/**
 * Pi heuristic cleanup for tool deduplication, system-injection stripping,
 * emergency tool reclamation, and age-tier text compression.
 *
 * The caller owns scheduler and force-materialization gating; this function
 * executes unconditionally when invoked.
 *
 * Cache safety: every mutation persists to the DB (`tags.status`,
 * `tags.drop_mode`, `source_contents`, `tags.caveman_depth`). Subsequent
 * defer passes read these durable signals via `applyFlushedStatuses` +
 * `replayCavemanCompression` so the visible message bytes stay stable
 * across passes.
 */

import {
	type ContextDatabase,
	getActiveTagsBySession,
	getMaxTagNumberBySession,
	replaceSourceContent,
	updateTagDropMode,
	updateTagStatus,
} from "@ufoq/mini-magic-context-core/features/magic-context/storage";
import {
	getEmergencyInputSample,
	setEmergencyDropSample,
} from "@ufoq/mini-magic-context-core/features/magic-context/storage-meta-persisted";
import type { TagEntry } from "@ufoq/mini-magic-context-core/features/magic-context/types";
import {
	applyCavemanCleanup,
	type CavemanCleanupConfig,
} from "@ufoq/mini-magic-context-core/hooks/magic-context/caveman-cleanup";
import {
	type EmergencyDropTag,
	planEmergencyDrop,
} from "@ufoq/mini-magic-context-core/hooks/magic-context/emergency-drop";
import { stripSystemInjection } from "@ufoq/mini-magic-context-core/hooks/magic-context/system-injection-stripper";
import type { TagTarget } from "@ufoq/mini-magic-context-core/hooks/magic-context/tag-messages";
import { stripTagPrefix } from "@ufoq/mini-magic-context-core/hooks/magic-context/tag-part-guards";
import { sessionLog } from "@ufoq/mini-magic-context-core/shared/logger";

/**
 * Same DEDUP_SAFE_TOOLS list OpenCode uses. Read-only tools whose
 * outputs are deterministic given the same input — duplicate calls
 * are wasted context. Anything mutating (write/edit/bash/etc.) is
 * intentionally excluded because two identical calls may have
 * different semantics in different positions of the conversation.
 */
const DEDUP_SAFE_TOOLS = new Set([
	"mcp_grep",
	"mcp_read",
	"mcp_glob",
	"mcp_ast_grep_search",
	"mcp_lsp_diagnostics",
	"mcp_lsp_symbols",
	"mcp_lsp_find_references",
	"mcp_lsp_goto_definition",
	"mcp_lsp_prepare_rename",
]);

export interface PiHeuristicCleanupConfig {
	protectedTags: number;
	/**
	 * Tiered target-headroom emergency drop (Phase 2). Provided only on the
	 * ≥85% force-materialize (cache-busting) pass; undefined on routine execute
	 * passes (routine age-based tool drops were removed). Mirrors OpenCode's
	 * `applyHeuristicCleanup` emergency config.
	 */
	emergency?: {
		currentTotalInputTokens: number;
		ceilingTokens: number;
	};
	/**
	 * Age-tier caveman text compression settings. Caller is responsible
	 * for forwarding this only for primary sessions where caveman is enabled.
	 */
	caveman?: CavemanCleanupConfig;
}

export interface PiHeuristicCleanupResult {
	droppedTools: number;
	deduplicatedTools: number;
	droppedInjections: number;
	emergencyDroppedTools: number;
	compressedTextTags: number;
	mutatedTextTags: number;
}

/**
 * Pi `AgentMessage[]` walker for tool-dedup fingerprinting.
 *
 * Returns one entry per assistant `toolCall` part whose tool name is
 * in DEDUP_SAFE_TOOLS, keyed by composite `<ownerMsgId>\x00<callId>` so
 * the dedup pass can match fingerprints to tool tags without collapsing
 * cross-owner reused call IDs.
 *
 * Mirrors OpenCode's `buildToolFingerprints` semantics, just with Pi
 * shape: assistant `content: PiToolCall[]` instead of OpenCode
 * `parts: [{ type: "tool_use" | "tool" | "tool-invocation", ... }]`.
 */
function buildPiToolFingerprints(
	messages: readonly unknown[],
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): Map<string, string> {
	const fingerprints = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const msg = message as {
			role?: unknown;
			content?: unknown;
			timestamp?: number;
		};
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		// ownerMsgId MUST match the id the transcript tagged this message with
		// (resolvePiStableId) — real entry id when resolvable, index fallback else.
		const ownerMsgId = resolveStableId(message, i);
		if (!ownerMsgId) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as {
				type?: unknown;
				id?: unknown;
				name?: unknown;
				arguments?: unknown;
			};
			if (p.type !== "toolCall") continue;
			if (typeof p.name !== "string") continue;
			if (!DEDUP_SAFE_TOOLS.has(p.name)) continue;
			if (typeof p.id !== "string" || p.id.length === 0) continue;
			// Skip sentinel toolCalls — these are already-dropped tool
			// shells we keep around to preserve `id` ↔ `toolCallId`
			// pairing for the provider serializer (see transcript-pi.ts
			// `replaceWithSentinel` for assistant toolCall parts). Their
			// `arguments` carry the `__magic_context_dropped__` marker
			// instead of real input; including them in dedup
			// fingerprints would collapse all dropped tools onto one
			// fingerprint and is a no-op anyway since tags are already
			// persisted as dropped.
			const args = p.arguments;
			if (
				args &&
				typeof args === "object" &&
				"__magic_context_dropped__" in (args as Record<string, unknown>)
			) {
				continue;
			}
			let serialized: string;
			try {
				serialized = JSON.stringify(args ?? {});
			} catch {
				continue; // unrepresentable args — skip dedup for this call
			}
			// Owner in BOTH key AND value: cross-owner identical read tools
			// are distinct invocations, while same-owner parallel duplicates
			// still share a fingerprint and can be deduplicated.
			const fingerprint = `${ownerMsgId}:${p.name}:${serialized}`;
			const compositeKey = `${ownerMsgId}\x00${p.id}`;
			fingerprints.set(compositeKey, fingerprint);
		}
	}
	return fingerprints;
}

/**
 * Apply heuristic cleanup to a Pi session. Mirrors OpenCode's
 * `applyHeuristicCleanup` 1:1 in semantics; differences are limited
 * to message-shape walking for tool fingerprinting (everything else
 * goes through `TagTarget` and shared helpers).
 *
 * Run order matches OpenCode:
 *   1. Drop aged tools (or all tools when `dropAllTools=true`).
 *   2. Strip system injections from message tags.
 *   3. Tool dedup (drop older identical calls of read-only tools).
 *   4. Age-tier caveman text compression (when enabled).
 *
 * Each pass commits within its own `db.transaction` so partial
 * progress survives mid-pass failures.
 */
export function applyPiHeuristicCleanup(
	sessionId: string,
	db: ContextDatabase,
	targets: Map<number, TagTarget>,
	piMessages: readonly unknown[],
	config: PiHeuristicCleanupConfig,
	preloadedTags: TagEntry[] | undefined,
	// Must be the same stable-id resolver used to tag the transcript.
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): PiHeuristicCleanupResult {
	// All work in this function short-circuits on `tag.status !== "active"`.
	// See OpenCode `applyHeuristicCleanup` for the full P0 perf rationale.
	const tags = preloadedTags ?? getActiveTagsBySession(db, sessionId);
	// `maxTag` must reflect the true session max (including dropped/compacted)
	// so the protected-cutoff window is anchored to the most recent tag
	// regardless of status. `getMaxTagNumberBySession` resolves with a
	// single backward index seek (O(log N)).
	const maxTag = getMaxTagNumberBySession(db, sessionId);
	const protectedCutoff = maxTag - config.protectedTags;
	let droppedTools = 0;
	let emergencyDroppedTools = 0;
	let deduplicatedTools = 0;
	let droppedInjections = 0;

	// ── Pass 1: tiered target-headroom emergency drop ─────────────────
	// Replaces the old need-blind aged-drop + dropAllTools nuke. Runs only when
	// the caller supplies `emergency` (≥85% cache-busting pass). Selection is
	// pure (`planEmergencyDrop`); we apply it and advance the persisted watermark
	// so each tag drops once. Mirrors OpenCode `applyHeuristicCleanup`.
	if (config.emergency) {
		const emergency = config.emergency;
		const priorInputSample = getEmergencyInputSample(db, sessionId);
		// Plan ONLY over tags in the live window that would ACTUALLY reclaim
		// bytes (canDrop, not mere drop() presence) — keeps the floor math equal
		// to the on-wire tail and avoids phantom under-evict. Mirrors OpenCode.
		const droppableTags = tags.filter(
			(t) =>
				t.status === "active" &&
				t.type === "tool" &&
				targets.get(t.tagNumber)?.canDrop?.(),
		);
		// Floor accounting needs the FULL active live-window set (all types) —
		// narrowing it to the droppable subset folds real conversation/
		// reasoning tail into the "irreducible prefix" and under-evicts.
		const activeTags = tags.filter((t) => t.status === "active");
		const plan = planEmergencyDrop({
			tags: droppableTags as readonly EmergencyDropTag[],
			floorTags: activeTags as readonly EmergencyDropTag[],
			maxTag,
			protectedTags: config.protectedTags,
			currentTotalInputTokens: emergency.currentTotalInputTokens,
			ceilingTokens: emergency.ceilingTokens,
			priorInputSample,
			hasPriorDrop: priorInputSample > 0,
		});
		if (plan.shouldDrop) {
			const toDrop = new Set(plan.tagNumbers);
			const newestEmergencyTags = new Set(
				droppableTags
					.slice()
					.sort((left, right) => right.tagNumber - left.tagNumber)
					.slice(0, 20)
					.map((tag) => tag.tagNumber),
			);
			db.transaction(() => {
				for (const tag of tags) {
					if (!toDrop.has(tag.tagNumber)) continue;
					if (tag.status !== "active" || tag.type !== "tool") continue;
					const target = targets.get(tag.tagNumber);
					const recent = newestEmergencyTags.has(tag.tagNumber);
					const result = recent
						? (target?.truncate?.() ?? target?.drop?.() ?? "absent")
						: (target?.drop?.() ?? "absent");
					if (result === "removed" || result === "truncated") {
						updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
						updateTagDropMode(
							db,
							sessionId,
							tag.tagNumber,
							recent ? "truncated" : "full",
						);
						droppedTools++;
						emergencyDroppedTools++;
					}
				}
				// The sample is latched after the transaction below for every acting
				// emergency pass, including zero removals.
			})();
			sessionLog(sessionId, `emergency tiered drop: ${plan.reason}`);
		} else {
			sessionLog(sessionId, `emergency tiered drop skipped: ${plan.reason}`);
		}
		// Record every acting emergency sample, including when no target was eligible.
		setEmergencyDropSample(db, sessionId, emergency.currentTotalInputTokens);
	}

	// ── Pass 2: strip system injections from message tags ─────────────
	db.transaction(() => {
		for (const tag of tags) {
			if (tag.status !== "active") continue;
			if (tag.tagNumber > protectedCutoff) continue;
			if (tag.type !== "message") continue;

			const target = targets.get(tag.tagNumber);
			if (!target) continue;

			const content = target.getContent?.();
			if (!content) continue;

			const stripped = stripSystemInjection(content);
			if (stripped === null) continue;
			const strippedSource = stripTagPrefix(stripped);

			if (strippedSource.trim().length === 0) {
				const dropResult = target.drop?.() ?? "absent";
				const didReplace =
					dropResult === "absent"
						? target.setContent(`[dropped §${tag.tagNumber}§]`)
						: false;
				if (dropResult === "removed" || dropResult === "absent") {
					replaceSourceContent(db, sessionId, tag.tagNumber, "");
					updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
					if (dropResult === "removed" || didReplace) {
						droppedInjections++;
					}
				}
			} else {
				const didSet = target.setContent(stripped);
				if (didSet) {
					replaceSourceContent(db, sessionId, tag.tagNumber, strippedSource);
					droppedInjections++;
				}
			}
		}
	})();

	// ── Pass 3: tool dedup (Pi-shape fingerprinter) ───────────────────
	const toolFingerprints = buildPiToolFingerprints(piMessages, resolveStableId);
	if (toolFingerprints.size > 0) {
		const tagsByCompositeKey = new Map<string, TagEntry>();
		for (const tag of tags) {
			if (
				tag.type === "tool" &&
				tag.status === "active" &&
				tag.messageId &&
				tag.toolOwnerMessageId
			) {
				tagsByCompositeKey.set(
					`${tag.toolOwnerMessageId}\x00${tag.messageId}`,
					tag,
				);
			}
		}

		const fingerprintGroups = new Map<string, TagEntry[]>();
		for (const [compositeKey, fingerprint] of toolFingerprints) {
			const tag = tagsByCompositeKey.get(compositeKey);
			if (!tag || tag.tagNumber > protectedCutoff) continue;
			const group = fingerprintGroups.get(fingerprint) ?? [];
			group.push(tag);
			fingerprintGroups.set(fingerprint, group);
		}

		db.transaction(() => {
			for (const [, group] of fingerprintGroups) {
				if (group.length <= 1) continue;
				group.sort((a, b) => a.tagNumber - b.tagNumber);
				// Keep the newest, drop the rest.
				for (let i = 0; i < group.length - 1; i++) {
					const tag = group[i];
					const target = targets.get(tag.tagNumber);
					// Deduplication stays full-drop; only emergency recent arcs keep skeletons.
					const result = target?.drop?.() ?? "absent";
					if (result === "incomplete") continue;
					updateTagDropMode(db, sessionId, tag.tagNumber, "full");
					updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
					if (result === "removed" || result === "truncated") {
						deduplicatedTools++;
					}
				}
			}
		})();
	}

	if (droppedTools > 0 || deduplicatedTools > 0 || droppedInjections > 0) {
		sessionLog(
			sessionId,
			`heuristic cleanup: dropped ${droppedTools} tool tags, deduplicated ${deduplicatedTools} tool calls, dropped ${droppedInjections} system injections`,
		);
	}

	// ── Pass 4: age-tier caveman text compression ─────────────────────
	let compressedTextTags = 0;
	let mutatedTextTags = 0;
	if (config.caveman?.enabled) {
		const cavemanResult = applyCavemanCleanup(sessionId, db, targets, tags, {
			enabled: true,
			minChars: config.caveman.minChars,
			protectedTags: config.protectedTags,
		});
		compressedTextTags =
			cavemanResult.compressedToLite +
			cavemanResult.compressedToFull +
			cavemanResult.compressedToUltra;
		mutatedTextTags = cavemanResult.mutatedTextTags;
	}

	return {
		droppedTools,
		deduplicatedTools,
		droppedInjections,
		emergencyDroppedTools,
		compressedTextTags,
		mutatedTextTags,
	};
}
