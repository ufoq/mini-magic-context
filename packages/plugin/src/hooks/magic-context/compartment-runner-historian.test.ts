import { describe, expect, it, mock } from "bun:test";

import {
    classifyHistorianFailureMessage,
    runValidatedHistorianPass,
} from "./compartment-runner-historian";

const CHUNK = {
    startIndex: 1,
    endIndex: 4,
    lines: [
        { ordinal: 1, messageId: "m1" },
        { ordinal: 2, messageId: "m2" },
        { ordinal: 3, messageId: "m3" },
        { ordinal: 4, messageId: "m4" },
    ],
};

const VALID_XML = [
    '<compartment start="1" end="4" title="Whole chunk"><p1>Summarized messages 1-4.</p1></compartment>',
    "<PROJECT_RULES>",
    "* Keep this fact.",
    "</PROJECT_RULES>",
].join("\n");

function createHarness(prompt: ReturnType<typeof mock>) {
    return {
        session: {
            create: mock(async () => ({ data: { id: "child" } })),
            prompt,
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [{ type: "text", text: VALID_XML }],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as never;
}

async function runPass(
    prompt: ReturnType<typeof mock>,
    overrides: Partial<Parameters<typeof runValidatedHistorianPass>[0]> = {},
) {
    return runValidatedHistorianPass({
        client: createHarness(prompt),
        parentSessionId: "ses-test",
        sessionDirectory: "/tmp",
        prompt: "Summarize messages 1-4.",
        chunk: CHUNK,
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "test",
        ...overrides,
    });
}

describe("runValidatedHistorianPass terminal handling", () => {
    it("walks the configured fallback chain once", async () => {
        const prompt = mock(async () => {
            if (prompt.mock.calls.length === 1) {
                throw new Error("401 unauthorized");
            }
            return {};
        });

        const result = await runPass(prompt, {
            fallbackModels: ["fallback/model"],
        });

        expect(result.ok).toBe(true);
        expect(prompt).toHaveBeenCalledTimes(2);
    });

    it("does not advance to fallback when child cleanup is unconfirmed", async () => {
        const prompt = mock(async () => {
            throw new Error("historian cleanup unconfirmed");
        });

        const result = await runPass(prompt, {
            fallbackModels: ["fallback/model"],
        });

        expect(result.ok).toBe(false);
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    it("does not advance to fallback after a terminal timeout", async () => {
        const prompt = mock(async () => {
            throw new Error("prompt timed out after 150000ms");
        });

        const result = await runPass(prompt, {
            fallbackModels: ["fallback/model"],
        });

        expect(result.ok).toBe(false);
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    it("retries an unowned transient failure without treating absent ownership as true", async () => {
        const prompt = mock(async () => {
            if (prompt.mock.calls.length === 1) {
                throw new Error("503 temporarily unavailable");
            }
            return {};
        });

        const result = await runPass(prompt);

        expect(result.ok).toBe(true);
        expect(prompt).toHaveBeenCalledTimes(2);
    });

    it("does not publish the draft when the editor times out", async () => {
        const prompt = mock(async () => {
            if (prompt.mock.calls.length === 1) return {};
            throw new Error("prompt timed out after 150000ms");
        });

        const result = await runPass(prompt, { twoPass: true });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("timed out");
    });

    it("classifies prefixed timeout messages without matching 500 in the budget", () => {
        expect(
            classifyHistorianFailureMessage(
                "Historian failed while processing this session: prompt timed out after 150000ms",
            ),
        ).toBe("timeout");
        expect(
            classifyHistorianFailureMessage(
                "Historian failed while processing this session: historian cleanup unconfirmed",
            ),
        ).toBe("unsafe");
        expect(classifyHistorianFailureMessage("500 provider error")).toBeNull();
    });
});
