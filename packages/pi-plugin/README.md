# Mini Magic Context — Pi extension

Historian-backed context management and journal search for [Pi coding agent](https://github.com/earendil-works/pi-mono). Compartments, embeddings, and indexed journal history are shared with the [OpenCode plugin](https://www.npmjs.com/package/@ufoq/opencode-mini-magic-context) via a single SQLite database.

Requires `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>= 0.80.2`.

---

## What it does

| Feature | What it does |
|---|---|
| **Historian** | Background subagent compresses old conversation into cache-stable chronological compartments |
| **`<session-history>` injection** | Prepends compressed history into the system prompt every turn so the agent never loses context |
| **Journal search (`ctx_search`)** | Queries compressed session history with optional semantic ranking |
| **History expansion (`ctx_expand`)** | Recovers the original transcript from any compressed compartment range |
| **Optional embeddings** | Semantic search over compartments using local `all-MiniLM-L6-v2` or any OpenAI-compatible endpoint |
| **Legacy import** | Imports compartments from a previous full Magic Context installation, per session |
| **Cross-harness sharing** | The same database is shared with the OpenCode plugin for the same project |

---

## Installation

```bash
npx @ufoq/mini-magic-context@latest setup --harness pi
```

This registers the extension with Pi's package list and writes a default `mini-magic-context.jsonc`. Run `doctor` afterward to verify the installation:

```bash
npx @ufoq/mini-magic-context@latest doctor --harness pi
```

---

## Configuration

Two config files (merged, project overrides user):

| Location | Scope |
|---|---|
| `<project>/.cortexkit/mini-magic-context.jsonc` | Project |
| `~/.config/cortexkit/mini-magic-context.jsonc` | User-wide |

Both are validated against a Zod schema. Invalid fields fall back to defaults; bad config never disables the plugin.

### Minimal config

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/ufoq/mini-magic-context/main/assets/magic-context.schema.json",
  "enabled": true,
  "historian": {
    "model": "anthropic/claude-haiku-4-5"
  },
  "embedding": {
    "provider": "local"
  }
}
```

---

## Commands

| Command | Description |
|---|---|
| `/ctx-status` | Live token breakdown, pending queue, cache state |
| `/ctx-flush` | Force-process pending operations |
| `/ctx-recomp` | Rebuild compartments from raw history |
| `/ctx-wrapup [N]` | Compact older live history, keeping newest N messages raw |
| `/mc-import-context [path]` | Import legacy Magic Context compartments |
| `/ctx-embed` | Embedding status; start or pause compartment embedding |

---

## Tools available to the agent

| Tool | Purpose |
|---|---|
| `ctx_search` | Search compartments and raw session history; returns ranked results with previews |
| `ctx_expand` | Recover the original transcript from a compressed compartment range |
| `todowrite` | Manage structured task lists surfaced in the session view |

---

## Storage

Everything lives in a single SQLite database:

```
~/.local/share/cortexkit/mini-magic-context/context.db
```

This is the same database the OpenCode plugin uses. Session-scoped data is keyed by `harness` (`'pi'` or `'opencode'`), so per-session tagging stays correctly attributed while compartments and embeddings are shared across harnesses.

Storage failures are fatal. The plugin refuses to register hooks rather than run with ephemeral state, since that would let context grow unbounded across restarts.

---

## Cross-harness coherence

Both plugins must use the same embedding model for semantic search to work across harnesses. A mismatch is detected on startup and warned.

---

## Architecture

This package is part of the [mini-magic-context monorepo](https://github.com/ufoq/mini-magic-context). The Pi extension shares core storage and tool implementations with the OpenCode plugin, exposing a Pi-specific adapter layer for session management, subprocess subagents, and config loading.

---

## License

MIT — see [LICENSE](https://github.com/ufoq/mini-magic-context/blob/master/LICENSE).
