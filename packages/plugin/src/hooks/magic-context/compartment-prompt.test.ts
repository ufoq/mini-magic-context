/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    buildCompartmentAgentPrompt,
    COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
} from "./compartment-prompt";

describe("compartment prompts", () => {
    it("has a structural recomp prompt with no side-channel extraction", () => {
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).toContain("structural recomp");
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).toContain("<meta>");
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).toContain("<unprocessed_from>");
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).not.toContain("<facts>");
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).not.toContain("<events>");
    });

    it("lays out session references then the new messages block", () => {
        const prompt = buildCompartmentAgentPrompt({
            sessionReferences:
                '<session_references>\n<compartment start="1" end="2" title="x" importance="50">\n<p1>a</p1>\n<p2>b</p2>\n<p3>c</p3>\n<p4/>\n</compartment>\n</session_references>',
            inputSource: "Messages 1-1:\n\nU: hi",
        });
        expect(prompt).toContain("<session_references>");
        expect(prompt).toContain("<new_messages>");
        expect(prompt).toContain("Messages 1-1:");
        // references must precede the input block
        expect(prompt.indexOf("<session_references>")).toBeLessThan(
            prompt.indexOf("<new_messages>"),
        );
    });

    it("omits the session references block for a young session", () => {
        const prompt = buildCompartmentAgentPrompt({
            sessionReferences: "",
            inputSource: "Messages 1-1:\n\nU: hi",
        });
        expect(prompt).not.toContain("<session_references>");
        expect(prompt).toContain("<new_messages>");
    });
});
