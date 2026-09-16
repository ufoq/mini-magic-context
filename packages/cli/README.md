# @ufoq/mini-magic-context

The setup and diagnostics CLI for **Mini Magic Context** — a context-management
extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

This package installs the `mini-magic-context` binary. It handles harness
detection, extension registration, config scaffolding, and health checks. The
runtime itself ships separately as
[`@ufoq/pi-mini-magic-context`](https://www.npmjs.com/package/@ufoq/pi-mini-magic-context),
which `setup` registers for you.

---

## Quick start

```bash
# Detect the harness, install the extension, write a default config
npx @ufoq/mini-magic-context@latest setup

# Target Pi explicitly
npx @ufoq/mini-magic-context@latest setup --harness pi

# Verify the installation
npx @ufoq/mini-magic-context@latest doctor
```

Pi must be version **0.74.0 or later**.

---

## Commands

| Command | What it does |
|---|---|
| `setup` | Interactive wizard: detects Pi, installs the extension, writes a default `mini-magic-context.jsonc` |
| `doctor` | Checks extension registration, config validity, database integrity, and embedding reachability |
| `doctor --force` | Same checks, then force-clears the plugin cache |
| `doctor --issue` | Collects a sanitized diagnostics bundle and opens a GitHub issue |
| `doctor --clear` | Interactive picker for clearing plugin caches |

### Flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--harness pi` | both | Target Pi only (default: auto-detect, prompt if ambiguous) |
| `--dry-run` | `setup` | Preview the wizard without writing any files |
| `--version`, `-v` | global | Print the CLI version and exit |
| `--help`, `-h` | global | Print usage and exit |

---

## Configuration

`setup` writes a `mini-magic-context.jsonc`. It is read from:

- `<project>/.cortexkit/mini-magic-context.jsonc` — project-level
- `~/.config/cortexkit/mini-magic-context.jsonc` — user-wide defaults

The full schema ships with the repository at
[`assets/magic-context.schema.json`](https://github.com/ufoq/mini-magic-context/blob/master/assets/magic-context.schema.json).

---

## What's not included

Mini Magic Context is a focused subset of full Magic Context. Project and user
memories (`ctx_memory`), notes (`ctx_note`), agent-driven reduction
(`ctx_reduce`), the Dreamer maintenance agent, sidekick augmentation, git commit
indexing, and the TUI dashboard are intentionally absent.

---

## License

MIT
