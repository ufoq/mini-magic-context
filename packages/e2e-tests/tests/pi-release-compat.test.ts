import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PiTestHarness } from "../src/pi-harness";
import { PI_CLI, PI_RUNTIME, PI_VERSION } from "../src/pi-runner/spawn";
import { buildMockHistorianPayload } from "../src/mock-historian";

const fixture = join(import.meta.dir, "../fixtures/pi-release-probe.ts");
const usage = {
  input_tokens: 1000,
  output_tokens: 20,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 0,
};
function systemText(body: Record<string, unknown>): string {
  return typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
}
function isHistorian(body: Record<string, unknown>): boolean {
  return systemText(body).includes("the hippocampus of a long-running coding agent");
}
function range(body: Record<string, unknown>): { start: number; end: number } {
  // Match transcript labels, not bracketed examples in the system instructions.
  const text = JSON.stringify(body.messages);
  const ordinals = [...text.matchAll(/\[(\d+)(?:-(\d+))?\]/g)].flatMap((m) => [Number(m[1]), Number(m[2] ?? m[1])]);
  if (!ordinals.length) throw new Error("No transcript ordinals in historian request");
  return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
}
function assertPromptAndTools(body: Record<string, unknown>) {
  expect(systemText(body)).toContain("## Magic Context");
  const names = (body.tools as Array<{ name: string }>).map((tool) => tool.name);
  expect(names).toContain("ctx_search");
  expect(names).toContain("ctx_expand");
  expect(names).not.toContain("ctx_reduce");
}
function toolResult(request: Record<string, unknown>, name: string): string {
  const messages = request.messages as Array<{ content: unknown }>;
  const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  return JSON.stringify(results.filter((b) => b.type === "tool_result" && b.tool_use_id === name));
}

describe("Pi release compatibility", () => {
  // Pi <1.2.0 drops before_agent_start prompt additions during custom-message runs.
  // Keep this check enabled on every host with the upstream fix, not an MC workaround.
  it.skipIf(
    Number(PI_VERSION.split(".")[0]) < 1 ||
      (Number(PI_VERSION.split(".")[0]) === 1 && Number(PI_VERSION.split(".")[1]) < 2),
  )(
    "keeps MC guidance through a custom triggerTurn and a tool round-trip (Pi >=1.2.0)",
    async () => {
      const h = await PiTestHarness.create({ extraExtensions: [fixture] });
      try {
        await h.sendPrompt("seed for custom-message run");
        h.mock.reset();
        h.mock.script([
          {
            content: [
              {
                type: "tool_use",
                id: "custom-search",
                name: "ctx_search",
                input: { query: "seed" },
              },
            ],
            stop_reason: "tool_use",
            usage,
          },
          { text: "custom run complete", usage },
        ]);
        const turn = await h.sendPrompt("/release-trigger", {
          timeoutMs: 30000,
        });
        expect(turn.stdout).toContain("ctx_search");
        expect(h.requests()).toHaveLength(2);
        for (const request of h.requests()) assertPromptAndTools(request.body);
        expect(toolResult(h.requests()[1]!.body, "custom-search")).not.toContain('"is_error":true');
      } finally {
        await h.dispose();
      }
    },
    60000,
  );

  it("reopens an existing session and keeps recall tools active after tree navigation", async () => {
    const h = await PiTestHarness.create({ extraExtensions: [fixture] });
    try {
      await h.sendPrompt("durable releasecanary: the chosen port is 47319");
      await h.sendPrompt("second branch turn");
      const before = await h.getState();
      await h.restart();
      expect((await h.getState()).sessionId).toBe(before.sessionId);
      await h.command("prompt", { message: "/release-snapshot" });
      const snapshot = JSON.parse(readFileSync(join(h.env.workdir, "release-snapshot.json"), "utf8"));
      expect(snapshot.cli).toBe(PI_CLI);
      console.log(
        `[matrix] version=${PI_VERSION} host=${snapshot.cli} runtime=${snapshot.runtime} requested=${PI_RUNTIME}`,
      );
      expect(snapshot.tools).toContain("ctx_search");
      expect(snapshot.tools).toContain("ctx_expand");
      const target = snapshot.branch.find(
        (e: { type: string; message?: { role: string } }) => e.type === "message" && e.message?.role === "assistant",
      ).id;
      await h.command("prompt", { message: `/release-navigate ${target}` });
      await h.command("prompt", { message: "/release-snapshot" });
      const navigated = JSON.parse(readFileSync(join(h.env.workdir, "release-snapshot.json"), "utf8"));
      expect(navigated.branch.at(-1).id).toBe(target);
      expect(navigated.tools).toContain("ctx_search");
      expect(navigated.tools).toContain("ctx_expand");
      h.mock.reset();
      h.mock.script([
        {
          content: [
            {
              type: "tool_use",
              id: "resume-search",
              name: "ctx_search",
              input: { query: "releasecanary" },
            },
          ],
          stop_reason: "tool_use",
          usage,
        },
        {
          content: [
            {
              type: "tool_use",
              id: "resume-expand",
              name: "ctx_expand",
              input: { message: 1 },
            },
          ],
          stop_reason: "tool_use",
          usage,
        },
        { text: "recall complete", usage },
      ]);
      await h.sendPrompt("recover the chosen port");
      expect(h.requests()).toHaveLength(3);
      for (const request of h.requests()) assertPromptAndTools(request.body);
      const recovered = toolResult(h.requests()[2]!.body, "resume-expand");
      expect(recovered).toContain("47319");
      expect(recovered).not.toContain('"is_error":true');
      expect(toolResult(h.requests()[1]!.body, "resume-search")).toContain("releasecanary");
    } finally {
      await h.dispose();
    }
  }, 90000);

  it("publishes through fallback after a real provider 429 and materializes on the wire", async () => {
    const h = await PiTestHarness.create({
      magicContextConfig: {
        execute_threshold_percentage: 40,
        historian: {
          model: "anthropic/claude-haiku-4-5",
          fallback_models: ["anthropic/claude-sonnet-4-5"],
        },
      },
    });
    let primaryErrors = 0;
    let fallbackRequests = 0;
    try {
      h.mock.addMatcher((body) => {
        if (!isHistorian(body)) return null;
        if (String(body.model).includes("haiku")) {
          primaryErrors++;
          return {
            error: {
              status: 429,
              type: "rate_limit_error",
              message: "429 release quota exhausted",
            },
          };
        }
        expect(String(body.model)).toContain("sonnet");
        fallbackRequests++;
        return {
          text: buildMockHistorianPayload({
            ...range(body),
            title: "Release fallback history",
            body: "The releasecanary port is 47319; preserved by the fallback historian.",
          }),
          usage,
        };
      });
      h.mock.setDefault({ text: "fill", usage });
      for (let i = 1; i <= 10; i++) await h.sendPrompt(`turn ${i}: releasecanary port 47319. ${h.ballast(3000)}`);
      h.mock.setDefault({
        text: "pressure",
        usage: {
          input_tokens: 90000,
          output_tokens: 20,
          cache_creation_input_tokens: 90000,
          cache_read_input_tokens: 0,
        },
      });
      const trigger = await h.sendPrompt("trigger historian");
      h.mock.setDefault({
        text: "follow-up",
        usage: {
          input_tokens: 500,
          output_tokens: 10,
          cache_read_input_tokens: 500,
        },
      });
      await h.sendPrompt("post-trigger");
      await h.waitFor(
        () => {
          const row = h
            .contextDb()
            .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ? AND harness = 'pi'")
            .get(trigger.sessionId) as { n: number };
          return row.n > 0;
        },
        { timeoutMs: 90000, label: "fallback publication" },
      );
      expect(primaryErrors).toBeGreaterThanOrEqual(3);
      expect(fallbackRequests).toBeGreaterThan(0);
      await h.waitFor(
        () => {
          const row = h
            .contextDb()
            .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = ?")
            .get(trigger.sessionId) as { compartment_in_progress: number };
          return row.compartment_in_progress === 0;
        },
        { timeoutMs: 30000 },
      );
      // Exercise the public materialization command after background publication.
      await h.command("prompt", { message: "/ctx-flush" });
      const requestCount = h.requests().length;
      for (let i = 0; i < 3; i++) await h.sendPrompt(`materializing pass ${i}`);
      const main = h
        .requests()
        .slice(requestCount)
        .filter((r) => !isHistorian(r.body));
      expect(main.length).toBeGreaterThan(0);
      expect(main.some((r) => JSON.stringify(r.body.messages).includes("Release fallback history"))).toBe(true);
      expect(main.some((r) => !JSON.stringify(r.body.messages).includes("turn 1:"))).toBe(true);
      for (const request of main) assertPromptAndTools(request.body);
      expect(h.countDroppedTags(trigger.sessionId!)).toBeGreaterThan(0);
      console.log(
        `[fallback] primary429=${primaryErrors} fallback=${fallbackRequests} dropped=${h.countDroppedTags(trigger.sessionId!)}`,
      );
    } finally {
      await h.dispose();
    }
  }, 180000);
});
