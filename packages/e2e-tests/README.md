# @ufoq/pi-mini-magic-context-e2e

End-to-end test harness for the Pi Mini Magic Context extension. It spawns a real Pi child process pointed at a local mock Anthropic server, drives sessions through Pi RPC, and asserts against SQLite state, log output, and captured provider requests.

## Running

```bash
# From repo root
bun run test:e2e

# Or directly in this package
cd packages/e2e-tests && bun test
```

## Architecture

- **`src/mock-provider/server.ts`** — Anthropic-compatible mock HTTP server. It accepts POST `/messages`, supports the response modes exercised by Pi, lets tests script responses with precise usage values, and captures every request body for assertions.
- **`src/pi-harness.ts`** — Pi RPC test harness.
- **`tests/pi-*.test.ts`** — Pi integration suites covering context management, historian execution, drops, search/tagging, todo synthesis, and overflow handling.

### Pi RPC harness

Pi e2e tests run through `pi --mode rpc`. Each `PiTestHarness` owns one persistent Pi subprocess for its lifetime and talks to it over strict JSONL on stdio. `harness.sendPrompt()` sends a `prompt` RPC command and collects the event slice from `agent_start` through `agent_end`.

## Configuration and storage

Tests use the standard Mini Magic Context paths:

- Config: `<project>/.cortexkit/mini-magic-context.jsonc`
- Database: `~/.local/share/cortexkit/mini-magic-context/context.db`

The harness provisions isolated directories so test runs do not touch real user data.

## Requirements

- Pi CLI installed (see `packages/pi-plugin/README.md`).
- Bun.

## Writing a test

```ts
import { PiTestHarness } from "../src/pi-harness";

const harness = await PiTestHarness.create();
harness.mock.script([
    { text: "response 1", usage: { input_tokens: 10_000, output_tokens: 50 } },
]);

await harness.sendPrompt("turn 1");
expect(harness.mock.requests().length).toBe(1);

await harness.dispose();
```
