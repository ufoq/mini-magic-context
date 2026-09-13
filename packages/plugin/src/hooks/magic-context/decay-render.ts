/**
 * Deterministic Pi compartment decay renderer.
 *
 * It selects a paraphrase tier from age, importance, and budget pressure, then
 * demotes oldest-first if necessary to satisfy the hard history budget.
 */

import { computeBudgetPressure, renderedTier, TIER_COST, type Tier } from "./decay-curve";
import { estimateTokens } from "./read-session-formatting";

/** Default history budget when a caller doesn't supply one. */
export const DEFAULT_HISTORY_BUDGET_TOKENS = 60_000;

/** Minimal compartment shape the renderer needs (subset of Compartment). */
export interface DecayRenderCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    startDate?: string | null;
    endDate?: string | null;
    p1: string;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
}

function escapeXmlContent(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDateRange(startDate?: string | null, endDate?: string | null): string {
    if (!startDate || !endDate) return "";
    if (startDate === endDate) return startDate;
    if (startDate.slice(0, 7) === endDate.slice(0, 7)) return `${startDate}→${endDate.slice(8)}`;
    return `${startDate}→${endDate}`;
}

function sanitizeCompartmentTitle(title: string): string {
    // Historian-authored titles are untrusted: Cc, line-separator, and paragraph-
    // separator runs must collapse or they can forge a visually multiline heading.
    return escapeXmlContent(title.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " "));
}

function compartmentHeading(c: DecayRenderCompartment): string {
    const dateRange = formatDateRange(c.startDate, c.endDate);
    const dateSegment = dateRange ? ` · ${dateRange}` : "";
    return `## ${c.startMessage}-${c.endMessage}${dateSegment} · ${sanitizeCompartmentTitle(c.title)}`;
}

function guardCompartmentBody(body: string): string {
    // A rendered body cannot open a new compartment; indent heading-like lines so
    // the next unindented `## ` line remains an unambiguous compartment boundary.
    return body.replace(/^## /gm, " ## ");
}

/** v2 paraphrase tier body with denser-tier and content fallbacks. */
function tierBody(c: DecayRenderCompartment, tier: number): string {
    const tiers = [c.p1, c.p2, c.p3, c.p4];
    const requested = tiers[tier - 1];
    if (typeof requested === "string") return requested.trim();
    for (let i = tier - 2; i >= 0; i--) {
        const t = tiers[i];
        if (typeof t === "string" && t.length > 0) return t.trim();
    }
    return (c.content ?? "").trim();
}

/**
 * Render a single compartment at an explicit tier. Exposed for the m[1]
 * "new compartments" block, which always renders newest compartments at P1
 * (full fidelity — no decay applies to brand-new deltas).
 */
export function renderCompartmentAtTier(c: DecayRenderCompartment, tier: number): string {
    return renderOneCompartment(c, tier);
}

function renderOneCompartment(c: DecayRenderCompartment, tier: number): string {
    if (tier >= 5) return ""; // archived
    const heading = compartmentHeading(c);

    const body = tierBody(c, tier);
    if (body.length === 0) return heading;
    return `${heading}\n${guardCompartmentBody(escapeXmlContent(body))}`;
}

/**
 * Compute the rendered tier for each compartment, given budget pressure derived
 * once from the whole set. `compartments` are in chronological order (oldest
 * first); the decay curve indexes from newest (1 = newest).
 */
function computeTiers(
    compartments: DecayRenderCompartment[],
    historyBudgetTokens: number,
): number[] {
    const total = compartments.length;
    const curveInputs = compartments.map((c, index) => ({
        index: total - index,
        importance: Math.max(1, Math.min(100, c.importance ?? 50)),
    }));
    const pressure =
        historyBudgetTokens > 0 ? computeBudgetPressure(curveInputs, historyBudgetTokens) : 1;

    return compartments.map((c, index) =>
        renderedTier(total - index, c.importance ?? 50, pressure, 0),
    );
}

/**
 * Render the decayed compartment history block. Optionally prefixes a memory
 * block. Never renders session facts (v2 faithful). Returns the joined body
 * (no <session-history> wrapper — callers add their own framing).
 */
export function renderDecayedCompartments(args: {
    compartments: DecayRenderCompartment[];
    historyBudgetTokens: number;
}): string {
    const { compartments, historyBudgetTokens } = args;
    if (compartments.length === 0) return "";

    const tiers = computeTiers(compartments, historyBudgetTokens);
    const renderedByTier = compartments.map(() => new Array<string | undefined>(6));
    const tokensByTier = compartments.map(() => new Array<number | undefined>(6));

    const renderedAt = (index: number, tier: number): string => {
        const cached = renderedByTier[index][tier];
        if (cached !== undefined) return cached;
        const rendered = renderOneCompartment(compartments[index], tier);
        renderedByTier[index][tier] = rendered;
        return rendered;
    };
    const tokensAt = (index: number, tier: number): number => {
        const cached = tokensByTier[index][tier];
        if (cached !== undefined) return cached;
        const rendered = renderedAt(index, tier);
        const tokens = rendered.length === 0 ? 0 : estimateTokens(rendered);
        tokensByTier[index][tier] = tokens;
        return tokens;
    };
    const render = (): string => {
        const parts: string[] = [];
        for (let i = 0; i < compartments.length; i++) {
            const rendered = renderedAt(i, tiers[i]);
            if (rendered.length > 0) parts.push(rendered);
        }
        return parts.join("\n\n");
    };

    let body = render();
    if (historyBudgetTokens <= 0) return body;

    // Sum memoized compartment counts while selecting tiers. A final joined-body
    // check below accounts for separators and tokenizer effects at boundaries.
    let runningTokens = 0;
    for (let i = 0; i < tiers.length; i++) {
        runningTokens += tokensAt(i, tiers[i]);
    }

    let guard = compartments.length * 5;
    let oldestDemotableIndex = 0;
    const demoteOldest = (): boolean => {
        while (oldestDemotableIndex < tiers.length && tiers[oldestDemotableIndex] >= 5) {
            oldestDemotableIndex += 1;
        }
        if (oldestDemotableIndex >= tiers.length) return false;

        const index = oldestDemotableIndex;
        const previousTier = tiers[index];
        const nextTier = previousTier + 1;
        runningTokens += tokensAt(index, nextTier) - tokensAt(index, previousTier);
        tiers[index] = nextTier;
        return true;
    };

    while (runningTokens > historyBudgetTokens && guard > 0) {
        if (!demoteOldest()) break;
        guard -= 1;
    }

    body = render();
    let exactTokens = estimateTokens(body);
    while (exactTokens > historyBudgetTokens && guard > 0) {
        if (!demoteOldest()) break;
        guard -= 1;
        body = render();
        exactTokens = estimateTokens(body);
    }
    return body;
}

/**
 * Extract a top-level m[0] block slice (e.g. "session-history", "project-docs",
 * "user-profile") for budget measurement and token attribution. Returns the
 * full `<tag>…</tag>` slice or null. `tag` must be a literal block name (the
 * caller controls it), so the constructed RegExp is safe.
 *
 * Shared so the materialize tightening loop measures ONLY the session-history
 * slice against the history budget (not the whole m[0], which also carries
 * project-docs / user-profile / project-memory — those have their own budgets),
 * and so the sidebar/status token attribution reads the same slices both
 * harnesses actually render.
 */
export function extractM0Block(m0Text: string, tag: string): string | null {
    const m = m0Text.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`));
    return m ? m[0] : null;
}

export { TIER_COST };
