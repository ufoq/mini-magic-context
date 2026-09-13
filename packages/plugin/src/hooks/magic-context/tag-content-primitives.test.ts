import { describe, expect, it } from "bun:test";

import {
    byteSize,
    isThinkingPart,
    peelLeadingMcTagNotation,
    stripTagPrefix,
} from "./tag-content-primitives";

const SECTION = "\u00a7";

const DEGREE = "\u00b0";

describe("stripTagPrefix (legacy canonical §N§ notation only)", () => {
    it("#given well-formed leading prefix #when stripTagPrefix runs #then removes it", () => {
        expect(stripTagPrefix(`${SECTION}42${SECTION} Hello`)).toBe("Hello");
    });

    it("#given stacked well-formed prefixes #when stripTagPrefix runs #then removes them", () => {
        expect(stripTagPrefix(`${SECTION}2030${SECTION} ${SECTION}2030${SECTION} Run`)).toBe("Run");
    });

    it("#given accumulated bare digit residue #when stripTagPrefix runs #then preserves digits", () => {
        expect(stripTagPrefix(`2030  2030  2030${DEGREE} Run clippy`)).toBe(
            `2030  2030  2030${DEGREE} Run clippy`,
        );
    });

    it("#given legitimate leading numbers #when stripTagPrefix runs #then preserves them", () => {
        expect(stripTagPrefix("99 files are located in folder zzz")).toBe(
            "99 files are located in folder zzz",
        );

        expect(stripTagPrefix("6 8 9 tasks from todo list completed")).toBe(
            "6 8 9 tasks from todo list completed",
        );

        expect(stripTagPrefix("1. do this now, 2. do that next")).toBe(
            "1. do this now, 2. do that next",
        );

        expect(stripTagPrefix("2024 roadmap")).toBe("2024 roadmap");
    });

    it("#given mid-text tag after bare digits #when stripTagPrefix runs #then leaves mid-text tag", () => {
        expect(stripTagPrefix(`2030  ${SECTION}42${SECTION} Hello`)).toBe(
            `2030  ${SECTION}42${SECTION} Hello`,
        );
    });

    it("#given a leading law citation #when stripTagPrefix runs #then leaves it intact", () => {
        // Regression for the deleted dangling/malformed passes: `§823` is
        // legitimate legal prose, not a Mini tag prefix.
        expect(stripTagPrefix(`${SECTION}823 BGB`)).toBe(`${SECTION}823 BGB`);
        expect(stripTagPrefix(`${SECTION}5.1 of the contract`)).toBe(
            `${SECTION}5.1 of the contract`,
        );
    });

    it("#given a stray section sign mid-text #when stripTagPrefix runs #then leaves it intact", () => {
        expect(stripTagPrefix(`See ${SECTION}5 of the contract.`)).toBe(
            `See ${SECTION}5 of the contract.`,
        );
    });
});

describe("peelLeadingMcTagNotation", () => {
    it("#given leading tag prefix #when peel runs #then splits prefix and body", () => {
        expect(peelLeadingMcTagNotation(`${SECTION}3${SECTION} hello`)).toEqual({
            tagPrefix: `${SECTION}3${SECTION} `,

            body: "hello",
        });
    });

    it("#given no leading prefix #when peel runs #then returns empty prefix", () => {
        expect(peelLeadingMcTagNotation("plain body")).toEqual({
            tagPrefix: "",
            body: "plain body",
        });
    });
});

describe("byteSize", () => {
    it("#given ascii string #when byteSize runs #then returns byte length", () => {
        expect(byteSize("hello")).toBe(5);
    });

    it("#given empty string #when byteSize runs #then returns 0", () => {
        expect(byteSize("")).toBe(0);
    });

    it("#given multibyte string #when byteSize runs #then returns encoded byte length", () => {
        expect(byteSize("§42§")).toBe(6);
    });
});

describe("isThinkingPart", () => {
    it("#given thinking part #when isThinkingPart runs #then returns true", () => {
        expect(isThinkingPart({ type: "thinking", thinking: "..." })).toBe(true);
    });

    it("#given reasoning part #when isThinkingPart runs #then returns true", () => {
        expect(isThinkingPart({ type: "reasoning", reasoning: "..." })).toBe(true);
    });

    it("#given text part #when isThinkingPart runs #then returns false", () => {
        expect(isThinkingPart({ type: "text", text: "hello" })).toBe(false);
    });

    it("#given null #when isThinkingPart runs #then returns false", () => {
        expect(isThinkingPart(null)).toBe(false);
    });

    it("#given primitive #when isThinkingPart runs #then returns false", () => {
        expect(isThinkingPart("string")).toBe(false);
    });
});
