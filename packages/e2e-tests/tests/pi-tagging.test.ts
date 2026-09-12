/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create();
});

afterAll(async () => {
    await h.dispose();
});

describe("pi tagging", () => {
    it("persists tags in the DB with harness='pi' (no §N§ prefixes on the wire)", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "tagged response",
            usage: { input_tokens: 120, output_tokens: 10, cache_creation_input_tokens: 120 },
        });

        const turn = await h.sendPrompt("please tag this pi message", { timeoutMs: 60_000 });
        expect(turn.exitCode).toBeNull();
        expect(turn.sessionId).toBeTruthy();

        const req = h.mock.lastRequest();
        // Mini removed the ctx_reduce tool, so §N§ prefixes are intentionally
        // suppressed on the wire (tags exist only for DB bookkeeping).
        expect(JSON.stringify(req!.body)).not.toMatch(/§\d+§/);

        await h.waitFor(() => h.countTags(turn.sessionId!) > 0, {
            timeoutMs: 5000,
            label: "pi tags persisted",
        });
        const row = h.contextDb()
            .prepare("SELECT harness FROM tags WHERE session_id = ? LIMIT 1")
            .get(turn.sessionId!) as { harness: string } | null;
        expect(row?.harness).toBe("pi");
    }, 60_000);
});
