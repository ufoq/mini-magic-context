import { describe, expect, it } from "bun:test";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import { buildAutoSearchHint } from "./auto-search-hint";

function message(content: string, score = 0.85): UnifiedSearchResult {
    return {
        source: "message",
        content,
        score,
        messageOrdinal: 1,
        messageId: "m1",
        role: "assistant",
    };
}

describe("buildAutoSearchHint", () => {
    it("returns null for empty results", () => {
        expect(buildAutoSearchHint([])).toBeNull();
    });

    it("wraps fragments in <ctx-search-hint>", () => {
        const hint = buildAutoSearchHint([message("install.sh uses bunx without --bun flag")]);
        expect(hint).not.toBeNull();
        expect(hint?.startsWith("<ctx-search-hint>")).toBe(true);
        expect(hint?.endsWith("</ctx-search-hint>")).toBe(true);
        expect(hint).toContain("ctx_search");
        expect(hint).toContain("If the fragments above seem relevant");
    });

    it("caps to max fragments", () => {
        const results = [message("one"), message("two"), message("three"), message("four")];
        const hint = buildAutoSearchHint(results, { maxFragments: 2 });
        const lines = (hint ?? "").split("\n").filter((l) => l.startsWith("- "));
        expect(lines).toHaveLength(2);
    });

    it("truncates overlong fragments with ellipsis", () => {
        const long = "a".repeat(500);
        const hint = buildAutoSearchHint([message(long)], { fragmentCharCap: 40 });
        expect(hint).not.toBeNull();
        // Find the bullet line
        const bullet = (hint ?? "").split("\n").find((l) => l.startsWith("- "));
        expect(bullet).toBeDefined();
        expect((bullet?.length ?? 0) <= 45).toBe(true);
        expect(bullet?.endsWith("…")).toBe(true);
    });

    it("compresses message content with caveman-ultra", () => {
        // "because" should become "//" under ultra compression.
        const hint = buildAutoSearchHint([
            message("install fails because Node handles stdin differently"),
        ]);
        expect(hint).toContain("//");
    });

    it("singular vs plural header", () => {
        const single = buildAutoSearchHint([message("one")]);
        expect(single).toContain("1 related fragment");
        const many = buildAutoSearchHint([message("one"), message("two")]);
        expect(many).toContain("2 related fragments");
    });
});
