# Mini Magic Context — Pi extension

Historian-backed context management and journal search for [Pi coding agent](https://github.com/earendil-works/pi-mono). It stores compartmented session history and optional embeddings in a local SQLite database.

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
  "$schema": "https://raw.githubusercontent.com/ufoq/mini-magic-context/master/assets/magic-context.schema.json",
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
| `/ctx-embed` | Embedding status; start or pause compartment embedding |

---

## Tools available to the agent

| Tool | Purpose |
|---|---|
| `ctx_search` | Search compartments and raw session history; returns ranked results with previews |
| `ctx_expand` | Recover the original transcript from a compressed compartment range |

---

## Storage

Everything lives in a single SQLite database:

```
~/.local/share/cortexkit/mini-magic-context/context.db
```

Session-scoped data is keyed by the Pi harness so separate sessions remain isolated while compartments and embeddings remain available to their owning session.

Storage failures are fatal. The plugin refuses to register hooks rather than run with ephemeral state, since that would let context grow unbounded across restarts.

---

## Architecture

This package is part of the [mini-magic-context monorepo](https://github.com/ufoq/mini-magic-context). The Pi extension uses the shared core for storage and context operations, with a Pi-specific adapter layer for session management, subprocess subagents, and config loading.

---

## License

MIT — see [LICENSE](https://github.com/ufoq/mini-magic-context/blob/master/LICENSE).
