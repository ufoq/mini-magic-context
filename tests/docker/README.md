# Docker E2E tests

Integration tests that prove the published plugin tarballs actually load and work end-to-end inside a clean Linux environment with real OpenCode / Pi binaries plus a mock LLM (aimock).

## What this covers

These tests sit above the in-process Bun e2e suite (`packages/e2e-tests/`) which hits the plugin pipeline directly. The docker layer covers what the in-process tests can't reach:

- **Real binaries** — the actual `opencode` and `pi` binaries users install
- **Real install path** — `bunx --bun ...@latest doctor --force` against an empty home directory
- **Real OS** — Debian bookworm
- **Real native modules** — `better-sqlite3` rebuilt for Linux x64
- **Cross-harness shared SQLite** — both harnesses point at `~/.local/share/cortexkit/mini-magic-context/context.db` and write distinct `harness` rows

What's intentionally not covered here (already exercised by `packages/e2e-tests/`): historian compartments, recomp, complex tool-call patterns, Anthropic-specific cache-token semantics, overflow recovery. Those tests need precise control over message shapes and provider responses, which is faster in-process.

## Layout

```
tests/docker/
├── Dockerfile.opencode          # Debian + Node + Bun + OpenCode + aimock
├── Dockerfile.pi                # Debian + Node + Bun + Pi + aimock
├── Dockerfile.setup-sandbox     # Clean interactive machine for wizard testing
├── setup-sandbox.sh             # Runner for the interactive sandbox
├── setup-sandbox-banner.sh      # Shell banner for the sandbox
├── test-opencode-e2e.sh         # 2-phase test: SETUP_SMOKE + SESSION_SMOKE
├── test-pi-e2e.sh               # 2-phase test: SETUP_SMOKE + SESSION_SMOKE
├── fixtures/
│   ├── aimock-opencode.cjs      # Mock LLM fixture for OpenCode session smoke
│   └── aimock-pi.cjs            # Mock LLM fixture for Pi session smoke
└── run-e2e.sh                   # Local runner: builds + runs both images
```

## Running locally

```bash
# Both harnesses
tests/docker/run-e2e.sh

# Just one
tests/docker/run-e2e.sh opencode
tests/docker/run-e2e.sh pi
```

The runner pre-builds the local plugin dists (the Dockerfiles `COPY` from `packages/*/dist/` rather than building inside the image).

Requires Docker with Linux/amd64 emulation. On Apple Silicon this means `--platform linux/amd64` (the runner sets it automatically).

## Running in CI

`.github/workflows/e2e-docker.yml` runs both jobs on pushes to `master`, pull requests touching plugin packages or `tests/docker/`, `v*` tag pushes, and manual `workflow_dispatch`.

## Test phases

### Phase 1 — `SETUP_SMOKE`

Starts from a clean home directory. Runs the non-interactive `doctor --force` flow and asserts:

- doctor exits with a successful summary
- the harness-specific config file gets created
- the plugin entry gets registered
- doctor reports zero failures

### Phase 2 — `SESSION_SMOKE`

Layers a minimal config and an aimock-pointed provider on top, then runs a single agent turn. Asserts:

- aimock responds to `/v1/models`
- the agent binary completes within 60s
- the plugin log is non-empty
- the shared SQLite DB exists
- session rows are written with the correct `harness` value

## Adding a new test

For a new always-on assertion, add a `check` line to the appropriate `test-*-e2e.sh`:

```bash
check "label that names what's being verified" \
    "test -f /path/that/should/exist"
```

For deeper scenarios (multi-turn, historian publication), prefer adding to `packages/e2e-tests/` instead — the in-process harness is faster to iterate on and has tighter control over message shapes.

## Interactive setup sandbox

A clean, throwaway machine for manually exercising the published `setup` and `doctor` wizards interactively. Installs the real published `@ufoq/mini-magic-context@latest` from npm, with OpenCode and Pi present, then drops you into a shell.

```bash
# build @latest and drop into an interactive shell
tests/docker/setup-sandbox.sh

# pin a specific version
tests/docker/setup-sandbox.sh 0.1.0
```

Verify the wizard writes to the correct locations on a fresh machine:

- user config — `~/.config/cortexkit/mini-magic-context.jsonc`
- project config — `<project>/.cortexkit/mini-magic-context.jsonc`
- shared DB — `~/.local/share/cortexkit/mini-magic-context/context.db`
