# Pi Docker E2E tests

Integration tests that prove the Pi extension and published Mini Magic Context CLI load and work end-to-end in a clean Linux environment with a real Pi binary and a mock LLM.

## What this covers

These tests sit above the Bun e2e suite in `packages/e2e-tests/`. The Docker layer covers installation and runtime details that are impractical to exercise in-process:

- **Real Pi binary** — the `pi` binary users install.
- **Real install path** — `mini-magic-context doctor --harness pi --force` against an empty home directory.
- **Real OS** — Debian bookworm.
- **Real native modules** — `better-sqlite3` rebuilt for Linux x64.
- **Local SQLite storage** — Pi creates and uses `~/.local/share/cortexkit/mini-magic-context/context.db`.

Historian compartments, recompilation, complex tool-call patterns, cache-token behavior, and overflow recovery belong in `packages/e2e-tests/`, where the Pi RPC harness provides precise control of message shapes and provider responses.

## Layout

```text
tests/docker/
├── Dockerfile.pi                # Debian + Node + Bun + Pi + mock LLM
├── Dockerfile.setup-sandbox     # Clean interactive machine for wizard testing
├── setup-sandbox.sh             # Runner for the interactive sandbox
├── setup-sandbox-banner.sh      # Shell banner for the sandbox
├── test-pi-e2e.sh               # Setup and session smoke test
├── fixtures/
│   └── aimock-pi.cjs            # Mock LLM fixture for Pi session smoke
└── run-e2e.sh                   # Local runner: builds and runs the Pi image
```

## Running locally

```bash
tests/docker/run-e2e.sh
```

The runner pre-builds the local Pi extension distribution because the Dockerfile copies the built `dist/` tree instead of building inside the image.

Docker must support Linux/amd64. On Apple Silicon, the runner supplies `--platform linux/amd64` automatically.

## Test phases

### `SETUP_SMOKE`

Starts from a clean home directory, runs non-interactive `doctor --force`, and verifies that Pi registration and configuration succeed.

### `SESSION_SMOKE`

Adds a minimal configuration pointed at the mock provider, runs one Pi agent turn, and verifies that the extension logs and SQLite database are created.

## Interactive setup sandbox

The sandbox is a clean, throwaway machine for manually exercising the published Pi setup and doctor flows:

```bash
# Build the latest package and open a shell
tests/docker/setup-sandbox.sh

# Pin a published version
tests/docker/setup-sandbox.sh 0.1.0
```

It lets you confirm that a fresh installation writes:

- user config: `~/.config/cortexkit/mini-magic-context.jsonc`
- project config: `<project>/.cortexkit/mini-magic-context.jsonc`
- database: `~/.local/share/cortexkit/mini-magic-context/context.db`
