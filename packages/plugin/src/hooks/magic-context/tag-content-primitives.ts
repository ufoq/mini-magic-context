import type { ThinkingLikePart } from "./tag-messages";

const encoder = new TextEncoder();

const TAG_PREFIX_REGEX = /^(?:§\d+§\s*)+/;

export function byteSize(value: string): number {
    return encoder.encode(value).length;
}

/**
 * Strip a leading MC tag prefix from transform-visible text.
 *
 * Mini never injects `§N§` prefixes any more (the `ctx_reduce` flow that
 * consumed them is gone), so this is a legacy read-time normalizer only: it
 * removes the canonical, unambiguous `§N§ ` shape that pre-Mini sessions may
 * still carry in stored history. Improvised variants (`§N$`, `§N">§`, stray
 * `§`) are deliberately left alone — they are indistinguishable from legitimate
 * text such as a leading `§823 BGB` law citation, and mangling real content is
 * worse than leaving a rare legacy artifact visible.
 *
 * Does not remove bare leading digits — those may be legitimate user content
 * (`99 files`, `2024 roadmap`, numbered lists).
 */
export function stripTagPrefix(value: string): string {
    return value.replace(TAG_PREFIX_REGEX, "");
}

/**
 * Split leading MC tag notation from the body (temporal marker injection).
 * Uses the same §-only rules as {@link stripTagPrefix}.
 */
export function peelLeadingMcTagNotation(value: string): { tagPrefix: string; body: string } {
    const body = stripTagPrefix(value);
    if (body === value) return { tagPrefix: "", body };
    return { tagPrefix: value.slice(0, value.length - body.length), body };
}

export function isThinkingPart(part: unknown): part is ThinkingLikePart {
    if (part === null || typeof part !== "object") return false;
    const candidate = part as Record<string, unknown>;
    return candidate.type === "thinking" || candidate.type === "reasoning";
}
