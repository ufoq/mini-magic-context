# Mini Magic Context

A TypeScript extension for [Pi](https://pi.coding) that keeps long coding sessions usable. A background historian compresses old history into cache-stable compartments. Journal search (`ctx_search`), raw-history expansion (`ctx_expand`), and optional semantic search over compartments let the agent find what it needs without compaction pauses.

## What's included

- **Background historian** compresses raw session history into tiered chronological compartments, cache-stable so your prompt prefix survives the whole session.
- **Journal search** (`ctx_search`) queries compressed session history.
- **Raw-history expansion** (`ctx_expand`) recovers the original transcript from any compressed compartment range.
- **Optional embeddings** (local `all-MiniLM-L6-v2` or any OpenAI-compatible endpoint) for semantic compartment search.
- **Legacy import** (`/mc-import-context`) imports compartments from a previous full Magic Context installation, per session.

## What's not included

Mini Magic Context is a focused subset. The following features from full Magic Context are intentionally absent:

- Project and user memories (`ctx_memory`)
- Notes and smart notes (`ctx_note`)
- Agent-driven content reduction (`ctx_reduce`)
- Dreamer overnight maintenance agent
- Sidekick context augmentation (`/ctx-aug`)
- Git commit indexing
- TUI sidebar and dashboard

## Quick start

Run the setup wizard. It detects Pi, installs the extension, and writes a default config.

```bash
npx @ufoq/mini-magic-context@latest setup
```

Target the harness explicitly:

```bash
npx @ufoq/mini-magic-context@latest setup --harness pi
```

### Pi setup

```bash
npx @ufoq/mini-magic-context@latest setup --harness pi
```

Pi requires version 0.74.0 or later. The extension registers itself in `~/.pi/agent/settings.json`. Drop a `mini-magic-context.jsonc` in `<project>/.cortexkit/` (project-level) or `~/.config/cortexkit/` (user-wide defaults). See the full [configuration schema](./assets/magic-context.schema.json).

### Troubleshooting

```bash
npx @ufoq/mini-magic-context@latest doctor
```

Doctor checks extension registration, config validity, database integrity, and embedding reachability. Add `--force` to auto-fix or `--issue` to produce a bug report.

## How it works

### Historian

When context usage rises, the historian compresses the oldest raw messages into compartments: deterministic summaries keyed to the messages they replace. Because the historian runs on a separate model (configured in your config), the primary agent stays responsive and never stops for compaction.

Compartments are injected cache-stably, so your prompt prefix survives across pass boundaries. The historian also fires on commit clusters (detected work-unit boundaries), keeping the live window small even when context pressure is low.

### Journal search (`ctx_search`)

Search the session's compressed history. The agent calls `ctx_search` with a natural-language query and gets ranked results from compartments, with optional semantic ranking when embeddings are enabled.

### History expansion (`ctx_expand`)

When a compressed compartment summary isn't enough, `ctx_expand` decompresses a range back to the original user/assistant transcript.

### Embeddings

Optional semantic search over compartments. The default `local` provider runs `Xenova/all-MiniLM-L6-v2` in-process, no external service required. Set the provider to `"openai-compatible"` for any OpenAI-compatible embeddings API. Set `"off"` to disable embeddings and fall back to keyword-only search.

### Legacy import

If you are migrating from a full Magic Context installation, `/mc-import-context` imports that session's existing compartments into mini-magic-context. The import is per session; run it once for each session you want to carry forward.

Optionally pass a path to the legacy database:

```
/mc-import-context /path/to/legacy/context.db
```

## Configuration

Settings live in `mini-magic-context.jsonc`. Project config merges on top of user-wide defaults.

| Location | Scope |
|---|---|
| `<project>/.cortexkit/mini-magic-context.jsonc` | Project |
| `~/.config/cortexkit/mini-magic-context.jsonc` | User-wide |

Full configuration schema: [magic-context.schema.json](./assets/magic-context.schema.json).

## Commands

| Command | Description |
|---|---|
| `/mc-import-context` | Import legacy Magic Context compartments into this session |
| `/ctx-status` | Current context usage, pending queue, cache TTL, historian progress |
| `/ctx-recomp` | Rebuild compartments from raw history (full or `<start>-<end>` range) |
| `/ctx-wrapup` | Compact older live history, keeping newest N messages raw |
| `/ctx-flush` | Force-process all pending operations immediately |
| `/ctx-embed` | Embedding status; start or pause compartment embedding |

## Development

Requirements: Bun >= 1.0

```sh
bun install
bun run build
bun run typecheck
bun test
bun run lint
bun run format
```

## License

[MIT](LICENSE)
