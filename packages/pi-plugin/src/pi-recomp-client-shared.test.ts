import { describe, expect, it, mock } from "bun:test";
import type { SubagentRunner } from "@ufoq/mini-magic-context-core/shared/subagent-runner";

import { createPiHistorianClient } from "./pi-recomp-client-shared";

function createClient(result: Awaited<ReturnType<SubagentRunner["run"]>>) {
	const run = mock(async () => result);
	const client = createPiHistorianClient({
		runner: { harness: "pi", run } as unknown as SubagentRunner,
		model: "primary/model",
		systemPrompt: "system",
		timeoutMs: 5_000,
		directory: "/tmp",
		notify: () => {},
	});
	return { client, run };
}

const promptInput = (signal?: AbortSignal) => ({
	path: { id: "child" },
	body: { parts: [{ type: "text", text: "summarize" }] },
	...(signal ? { signal } : {}),
});

describe("createPiHistorianClient", () => {
	it("forwards the caller signal and uses a deadline shorter than the outer timer", async () => {
		const { client, run } = createClient({
			ok: true,
			assistantText: "ok",
			durationMs: 1,
		});
		const controller = new AbortController();

		await client.session.prompt(promptInput(controller.signal));

		expect(run).toHaveBeenCalledTimes(1);
		const options = run.mock.calls[0][0];
		expect(options.signal).toBe(controller.signal);
		expect(options.timeoutMs).toBe(5_000);
		expect(options.totalTimeoutMs).toBe(4_000);
		expect(options.fallbackModels).toBeUndefined();
	});

	it("maps a runner timeout to the configured-timeout sentinel", async () => {
		const { client } = createClient({
			ok: false,
			reason: "timeout",
			error: "pi subagent timed out after 4000ms",
			durationMs: 4_000,
		});

		const failure = client.session.prompt(promptInput());
		await expect(failure).rejects.toThrow("prompt timed out after 5000ms");
		const error = await failure.catch((caught: unknown) => caught);
		expect(error).not.toHaveProperty("piRetryObserved");
	});

	it("maps cleanup failure to the terminal sentinel", async () => {
		const { client } = createClient({
			ok: false,
			reason: "timeout",
			error: "pi subagent timed out after 4000ms",
			durationMs: 4_000,
			meta: { cleanupFailure: "live_child_unconfirmed" },
		});

		await expect(client.session.prompt(promptInput())).rejects.toThrow(
			"historian cleanup unconfirmed",
		);
	});

	it("maps a caller abort to the external-abort sentinel", async () => {
		const { client } = createClient({
			ok: false,
			reason: "abort",
			error: "pi subagent aborted by caller",
			durationMs: 1,
		});

		await expect(client.session.prompt(promptInput())).rejects.toThrow(
			"prompt aborted by external signal",
		);
	});

	it("provides a no-op session abort so timeout cleanup does not fail", async () => {
		const { client } = createClient({
			ok: true,
			assistantText: "ok",
			durationMs: 1,
		});

		await expect(
			client.session.abort({ path: { id: "child" } }),
		).resolves.toEqual({});
	});
});
