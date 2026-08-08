import { describe, expect, it } from "bun:test";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    buildReferenceBlocks,
    renderSessionReferencesBlock,
    SESSION_REF_WINDOW,
} from "./reference-retrieval";

function makeCompartment(over: Partial<Compartment> & { sequence: number }): Compartment {
    return {
        id: over.sequence,
        sessionId: "ses_test",
        sequence: over.sequence,
        startMessage: over.startMessage ?? over.sequence * 10 + 1,
        endMessage: over.endMessage ?? over.sequence * 10 + 9,
        startMessageId: `m${over.sequence}a`,
        endMessageId: `m${over.sequence}b`,
        title: over.title ?? `Compartment ${over.sequence}`,
        content: over.content ?? `flat content ${over.sequence}`,
        p1: over.p1 ?? null,
        p2: over.p2 ?? null,
        p3: over.p3 ?? null,
        p4: over.p4 ?? null,
        importance: over.importance ?? 50,
        episodeType: over.episodeType ?? null,
        legacy: over.legacy ?? (over.p1 ? 0 : 1),
        createdAt: 1000 + over.sequence,
    };
}

describe("renderSessionReferencesBlock", () => {
    it("returns empty string for a young session (no compartments)", () => {
        expect(renderSessionReferencesBlock([])).toBe("");
    });

    it("shows only the last SESSION_REF_WINDOW compartments", () => {
        const comps = Array.from({ length: 10 }, (_, i) =>
            makeCompartment({
                sequence: i,
                p1: `tier1-${i}`,
                p2: `t2-${i}`,
                p3: `t3-${i}`,
                p4: `t4-${i}`,
            }),
        );
        const block = renderSessionReferencesBlock(comps);
        // last 6 → sequences 4..9 present, 0..3 absent
        expect(block).toContain("tier1-9");
        expect(block).toContain("tier1-4");
        expect(block).not.toContain("tier1-3");
        const count = (block.match(/<compartment /g) ?? []).length;
        expect(count).toBe(SESSION_REF_WINDOW);
    });

    it("renders v2 rows with all four tiers (p4 self-closes when empty)", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({
                sequence: 0,
                p1: "P1",
                p2: "P2",
                p3: "P3",
                p4: "",
                importance: 70,
                episodeType: "bug",
            }),
        ]);
        expect(block).toContain("<p1>\nP1\n</p1>");
        expect(block).toContain("<p2>\nP2\n</p2>");
        expect(block).toContain("<p3>\nP3\n</p3>");
        expect(block).toContain("<p4/>"); // empty p4 self-closes
        expect(block).toContain('importance="70"');
        expect(block).toContain('episode_type="bug"');
    });

    it("renders legacy rows as flat content with no tier tags", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({ sequence: 0, content: "old flat body", legacy: 1 }),
        ]);
        expect(block).toContain("old flat body");
        expect(block).not.toContain("<p1>");
    });

    it("escapes title attribute", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({
                sequence: 0,
                title: 'a "quoted" & <wild>',
                p1: "x",
                p2: "y",
                p3: "z",
                p4: "",
            }),
        ]);
        expect(block).not.toContain('title="a "quoted"');
        expect(block).toContain("&quot;");
    });
});

describe("buildReferenceBlocks", () => {
    it("produces empty session refs when young", () => {
        const blocks = buildReferenceBlocks({
            sessionCompartments: [],
        });
        expect(blocks.sessionReferences).toBe("");
    });

    it("produces the session references block for a mature session", () => {
        const comps = [makeCompartment({ sequence: 0, p1: "a", p2: "b", p3: "c", p4: "" })];
        const blocks = buildReferenceBlocks({
            sessionCompartments: comps,
        });
        expect(blocks.sessionReferences).toContain("<session_references>");
    });

    it("is fully deterministic (no embedding/clock/db)", () => {
        const comps = [makeCompartment({ sequence: 0, p1: "a", p2: "b", p3: "c", p4: "d" })];
        const a = buildReferenceBlocks({
            sessionCompartments: comps,
        });
        const b = buildReferenceBlocks({
            sessionCompartments: comps,
        });
        expect(a).toEqual(b);
    });
});
