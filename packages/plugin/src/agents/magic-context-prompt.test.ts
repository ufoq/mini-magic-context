import { describe, expect, it } from "bun:test";
import { buildMagicContextSection } from "./magic-context-prompt";

const CAVEMAN_MARKER = "BEWARE";
const CAVEMAN_PHRASE_TAIL = "consciously revert to full sentences";

const KNOWN_AGENT_IDENTITIES = [
    "sisyphus",
    "atlas",
    "hephaestus",
    "sisyphus-junior",
    "oracle",
    "athena",
    "athena-junior",
] as const;

describe("buildMagicContextSection", () => {
    it("emits the same mini guidance for all known agent identities", () => {
        const generic = buildMagicContextSection(null, 20, true, false, false, false);

        for (const agent of KNOWN_AGENT_IDENTITIES) {
            expect(buildMagicContextSection(agent, 20, true, false, false, false)).toBe(generic);
        }
    });

    it("describes only retained journal search and expansion tools", () => {
        const out = buildMagicContextSection(null, 20, true, false, false, false);

        expect(out).toContain("## Magic Context");
        expect(out).toContain("long-term partner on this project");
        expect(out).toContain("Use `ctx_search`");
        expect(out).toContain("Use `ctx_expand`");
        expect(out).not.toContain("ctx_reduce");
        expect(out).not.toContain("ctx_memory");
        expect(out).not.toContain("ctx_note");
        expect(out).not.toContain("Reduction Triggers");
    });

    it("ignores ctx_reduce and memory-mode positional flags", () => {
        const reduce = buildMagicContextSection(null, 20, true, false, false, false);
        const noReduce = buildMagicContextSection(null, 20, false, false, false, false);
        const memoryOn = buildMagicContextSection(
            null,
            20,
            true,
            false,
            false,
            false,
            false,
            undefined,
            true,
        );

        expect(noReduce).toBe(reduce);
        expect(memoryOn).toBe(reduce);
    });

    it("uses the same mini guidance in subagent mode", () => {
        const primary = buildMagicContextSection(null, 20, true, false, false, false, false);
        const subagent = buildMagicContextSection(null, 20, true, false, false, false, true);

        expect(subagent).toBe(primary);
    });

    it("emits the caveman warning when enabled", () => {
        const out = buildMagicContextSection(null, 20, false, false, false, true);

        expect(out).toContain(CAVEMAN_MARKER);
        expect(out).toContain(CAVEMAN_PHRASE_TAIL);
        expect(out).toContain("DO NOT mimic this style");
    });

    it("omits the caveman warning when disabled", () => {
        const out = buildMagicContextSection(null, 20, false, false, false, false);

        expect(out).not.toContain(CAVEMAN_MARKER);
        expect(out).not.toContain(CAVEMAN_PHRASE_TAIL);
    });
});
