/**
 * Reference retrieval for the historian prompt.
 *
 * The historian receives one reference block (replacing the old unbounded
 * `<existing_state>` compartment dump and the removed cross-project seed corpus):
 *
 *   <session_references>                          — last 6 compartments THIS
 *       session wrote, full stored form (all tiers + importance + episode_type).
 *       Continuity + same-project format/importance calibration. RECENCY-based
 *       (no embedding at historian time — embedding K/L/M was dropped; see
 *       AUDIT E1 input-model decisions). ctx_search semantic retrieval over
 *       compartments is served by per-compartment chunk embeddings computed on
 *       publish (compartment-embedding.ts).
 *
 * The cross-project calibration corpus (reference-seeds) is REMOVED: no built
 * bundle imports it. A young session with no prior compartments simply gets an
 * empty `<session_references>` block.
 */
import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";

/**
 * Structural minimum a compartment must satisfy to render as a session
 * reference. Both `Compartment` (stored rows, incremental runner) and
 * `CandidateCompartment` (in-flight recomp staging) are assignable — they
 * differ only in null/undefined widening on the tier/importance fields.
 */
export interface ReferenceCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episodeType?: string | null;
}

/** Recency window of this-session compartments shown for continuity/calibration. */
export const SESSION_REF_WINDOW = 6;

/**
 * Render one this-session compartment in its full stored form for the
 * `<session_references>` block. v2 rows emit all four tiers; legacy rows (no
 * tiers) fall back to flat `content`. importance/episode_type are shown so the
 * historian calibrates against its own prior scoring.
 */
function renderSessionRefCompartment(c: ReferenceCompartment): string {
    const importance = c.importance ?? 50;
    const attrs =
        `start="${c.startMessage}" end="${c.endMessage}" title="${escapeXmlAttr(c.title)}"` +
        (c.episodeType ? ` episode_type="${escapeXmlAttr(c.episodeType)}"` : "") +
        ` importance="${importance}"`;

    // Tier presence: a row is v2-tiered ONLY when `p1` is a non-empty string
    // (matches the compartment parser's contract + the NEEDS_UPGRADE predicate
    // `legacy=1 OR p1 IS NULL OR p1=''`). Legacy rows (NULL p1) AND malformed
    // pseudo-v2 rows (`p1=''` from an interrupted upgrade) both fall through to
    // flat `content` — otherwise the reference block emitted empty <p1>/<p2>/<p3>
    // and lost the row's continuity/calibration content.
    // Tier bodies are XML-escaped: user/assistant text containing <, >, & would
    // otherwise produce malformed XML in the historian's reference-input prompt.
    if (typeof c.p1 === "string" && c.p1.length > 0) {
        // v2 tiered row: show all four paraphrase tiers exactly as stored. p4 may be
        // empty (self-closing) per the three valid P4 shapes.
        const p4 = c.p4 && c.p4.length > 0 ? `<p4>\n${escapeXmlContent(c.p4)}\n</p4>` : "<p4/>";
        return [
            `<compartment ${attrs}>`,
            `<p1>\n${escapeXmlContent(c.p1)}\n</p1>`,
            `<p2>\n${escapeXmlContent(c.p2 ?? "")}\n</p2>`,
            `<p3>\n${escapeXmlContent(c.p3 ?? "")}\n</p3>`,
            p4,
            `</compartment>`,
        ].join("\n");
    }

    // Legacy (pre-v2) row: no tiers, show flat content. The historian treats this
    // as continuity context only; it never has to reproduce this shape.
    return `<compartment ${attrs}>\n${escapeXmlContent(c.content)}\n</compartment>`;
}

/**
 * Render the continuity block from the last `SESSION_REF_WINDOW` persisted
 * compartments. `allCompartments` is the session's full ordered compartment
 * list (ascending by sequence/endMessage). Empty string when the session has
 * no prior compartments (young session — no references).
 */
export function renderSessionReferencesBlock(allCompartments: ReferenceCompartment[]): string {
    if (allCompartments.length === 0) return "";
    const recent = allCompartments.slice(-SESSION_REF_WINDOW);
    const body = recent.map(renderSessionRefCompartment).join("\n\n");
    return `<session_references>\n${body}\n</session_references>`;
}

export interface ReferenceBlocks {
    /** `<session_references>` — empty for a young session with no prior compartments. */
    sessionReferences: string;
}

/**
 * Build the reference block for a historian run. Pure + deterministic for a
 * given session compartment list — no embedding, no DB, no clock.
 */
export function buildReferenceBlocks(args: {
    /** Full ordered list of this session's persisted compartments (asc). */
    sessionCompartments: ReferenceCompartment[];
}): ReferenceBlocks {
    return {
        sessionReferences: renderSessionReferencesBlock(args.sessionCompartments),
    };
}
