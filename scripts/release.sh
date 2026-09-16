#!/usr/bin/env bash
set -euo pipefail

# release.sh — Validate, tag, push, and publish a Mini Magic Context release
#
# Usage:
#   ./scripts/release.sh 0.1.0              # full release: checks → tag → push → publish
#   ./scripts/release.sh 0.1.0 --dry        # preview version sync only; nothing is written
#   ./scripts/release.sh 0.1.0 --no-publish # tag + push, but stop before npm publish
#
# What it does:
#   1. Validates the version is semver and the tag is unused
#   2. Checks for a clean working tree and an in-sync lockfile
#   3. Runs pre-release checks (lint, typecheck, tests, build, Pi e2e)
#   4. Regenerates the JSON schema and re-lints it
#   5. Syncs the version across all three packages
#   6. Commits the bump, creates tag mini-vX.Y.Z, pushes to the git remotes
#   7. Publishes the two public packages to npm
#
# Publishing:
#   packages/plugin is private and is NEVER published — its code is inlined
#   into the two public bundles at build time. The published packages are
#   packages/pi-plugin (@ufoq/pi-mini-magic-context) and packages/cli
#   (@ufoq/mini-magic-context).
#
#   Set NPM_PUBLISH_URL to publish through a token-holding gate that accepts a
#   raw `npm pack` tarball as application/octet-stream. Otherwise the script
#   calls `npm publish` directly, which requires an authenticated session
#   (verify with `npm whoami`).
#
# Remotes:
#   Pushing to `origin` is required. Any other remote (e.g. a GitHub mirror) is
#   pushed best-effort: a failure is reported as a warning but does not abort
#   the release, since mirror auth can differ from origin's.

VERSION="${1:-}"
DRY="${2:-}"
NO_PUBLISH="${3:-}"
# Accept the flags in either order.
if [[ "$DRY" == "--no-publish" ]]; then DRY=""; NO_PUBLISH="--no-publish"; fi
if [[ "$NO_PUBLISH" == "--dry" ]]; then NO_PUBLISH=""; DRY="--dry"; fi

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version> [--dry | --no-publish]"
  echo "  e.g. ./scripts/release.sh 0.1.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z)"
  exit 1
fi

# The `mini-` prefix is load-bearing: the bare `v*` tag namespace is already
# occupied by the retired @cortexkit/opencode-magic-context line (v0.1.0–v0.22.3,
# published to npm up to 0.42.5), whose tags still live on origin and GitHub.
# Reusing v0.1.0 would collide with that history. The dashboard line set the
# precedent for a family prefix (`dashboard-v*`); Mini Magic Context uses
# `mini-v*`.
TAG="mini-v$VERSION"

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag '$TAG' already exists"
  exit 1
fi

# Check for clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  git status --short
  exit 1
fi

# Check we're on main/master
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  echo "Warning: releasing from '$BRANCH' (not main/master)"
  read -rp "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""
echo "  Releasing Mini Magic Context $TAG"
echo "  ─────────────────────────────"
echo ""

# Step 1: Dry run preview
if [[ "$DRY" == "--dry" ]]; then
  echo "→ Version sync (dry run):"
  bun scripts/version-sync.mjs "$VERSION" --dry-run
  echo ""
  echo "[DRY RUN] Would commit, tag $TAG, push to the git remotes, and publish to npm."
  exit 0
fi

# Step 2: Pre-release checks
echo "→ Running pre-release checks..."
echo ""

PLUGIN_DIR="packages/plugin"
PI_DIR="packages/pi-plugin"
CLI_DIR="packages/cli"
E2E_DIR="packages/e2e-tests"

# The lockfile is tracked, so a fresh clone must be able to install from it with
# --frozen-lockfile. If package.json drifted from bun.lock, CI and every fresh
# clone break even though this working tree still builds from node_modules.
# Gate on it here rather than discovering it after the tag is cut.
echo "  [deps] bun install --frozen-lockfile..."
if ! bun install --frozen-lockfile 2>&1; then
  echo "Error: bun.lock is out of sync with package.json"
  echo "       run 'bun install' and commit the updated bun.lock before releasing"
  exit 1
fi

# Run `bun test` for a package and gate on a TRUE pass, not just "no fail line".
#
# Bun has a known post-completion panic on large suites: every test passes and
# the full summary prints, but the process then exits non-zero. We must tolerate
# THAT specific case without becoming fail-open. The old gate (`|| true` + grep
# for "N fail") passed on a panic before any tests ran, a harness timeout, a
# zero-tests-collected run, or any Bun output-format change — all of which a
# release must block on.
#
# Robust gate: require BOTH (a) a positive "<n> pass" completion line AND
# (b) zero "<n> fail". If the exit code is 0 we trust it directly; if non-zero
# we only accept it when the pass/fail summary proves the suite actually ran
# and was green (the Bun-panic case).
run_package_tests() {
  local label="$1" dir="$2" output status
  echo "  [$label] bun test..."
  # `set -e` would abort the script at this assignment the instant `bun test`
  # exits non-zero — BEFORE `status=$?` and the panic-tolerance below could
  # run. Bun sometimes exits non-zero with a post-completion panic AFTER
  # printing a fully-green summary; the grep checks below are the real gate.
  # Use `|| status=$?` so errexit doesn't fire and the tolerance is reachable.
  status=0
  output=$(bun test --cwd "$dir" 2>&1) || status=$?
  echo "$output"
  if echo "$output" | grep -qE "[1-9][0-9]* fail"; then
    echo "Error: $label tests failed (fail count > 0)"
    exit 1
  fi
  if ! echo "$output" | grep -qE "[1-9][0-9]* pass"; then
    echo "Error: $label tests produced no passing-test summary (crash, timeout, or zero tests collected)"
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "  [$label] note: tests passed but Bun exited $status (known post-completion panic) — tolerated"
  fi
}

echo "  [plugin] bun lint..."
bun run --cwd "$PLUGIN_DIR" lint 2>&1 || { echo "Error: Plugin lint failed"; exit 1; }

echo "  [plugin] bun typecheck..."
bun run --cwd "$PLUGIN_DIR" typecheck 2>&1 || { echo "Error: Plugin typecheck failed"; exit 1; }

run_package_tests "plugin" "$PLUGIN_DIR"

echo "  [plugin] bun build..."
bun run --cwd "$PLUGIN_DIR" build 2>&1 || { echo "Error: Plugin build failed"; exit 1; }

# Copy root README into the Pi package (this is what gets published).
cp README.md "$PI_DIR/README.md"

echo "  [pi-plugin] bun lint..."
bun run --cwd "$PI_DIR" lint 2>&1 || { echo "Error: Pi-plugin lint failed"; exit 1; }

echo "  [pi-plugin] bun typecheck..."
bun run --cwd "$PI_DIR" typecheck 2>&1 || { echo "Error: Pi-plugin typecheck failed"; exit 1; }

run_package_tests "pi-plugin" "$PI_DIR"

echo "  [pi-plugin] bun build..."
bun run --cwd "$PI_DIR" build 2>&1 || { echo "Error: Pi-plugin build failed"; exit 1; }

echo "  [cli] bun lint..."
bun run --cwd "$CLI_DIR" lint 2>&1 || { echo "Error: CLI lint failed"; exit 1; }

echo "  [cli] bun typecheck..."
bun run --cwd "$CLI_DIR" typecheck 2>&1 || { echo "Error: CLI typecheck failed"; exit 1; }

run_package_tests "cli" "$CLI_DIR"

echo "  [cli] bun build..."
bun run --cwd "$CLI_DIR" build 2>&1 || { echo "Error: CLI build failed"; exit 1; }

# Pi host behavior E2E suite (packages/e2e-tests). This is the deep suite that
# spawns a real Pi subprocess (resolved from node_modules) against a mock
# provider — it lives outside the per-package `bun test` runs above and was
# previously caught only in CI's host-e2e jobs. Running it here means a broken
# e2e fails the release locally instead of after a full tag → CI round-trip.
#
# NODE_ENV="" matches the normal runtime the spawned Pi subprocess expects (a
# stray NODE_ENV=test changes plugin logging/behavior).
run_e2e_group() {
  local label="$1" files="$2" output status
  echo "  [e2e:$label] bun test..."
  status=0
  output=$(cd "$E2E_DIR" && NODE_ENV="" bun test --timeout 600000 $files 2>&1) || status=$?
  echo "$output"
  if echo "$output" | grep -qE "[1-9][0-9]* fail"; then
    echo "Error: e2e ($label) failed (fail count > 0)"
    exit 1
  fi
  if ! echo "$output" | grep -qE "[1-9][0-9]* pass"; then
    echo "Error: e2e ($label) produced no passing-test summary (crash, timeout, or zero tests collected)"
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "  [e2e:$label] note: tests passed but Bun exited $status (known post-completion panic) — tolerated"
  fi
}

E2E_PI_FILES=$(ls "$E2E_DIR"/tests/pi-*.test.ts | sed "s#$E2E_DIR/##" | tr '\n' ' ')
run_e2e_group "pi" "$E2E_PI_FILES"

echo "  ✓ All checks passed"
echo ""

# Step 3: Generate JSON Schema
echo "→ Generating JSON Schema..."
bun packages/plugin/scripts/build-schema.ts || { echo "Error: Schema generation failed"; exit 1; }
echo ""

# Step 3b: Re-lint generated artifacts. The pre-release lint (above) runs BEFORE
# generation, so a generator that emits non-repo-style output would otherwise
# only fail after the tag is cut. Lint the regenerated files here so any
# formatting drift fails locally.
echo "→ Linting generated artifacts..."
bun run --cwd "$PLUGIN_DIR" lint 2>&1 || { echo "Error: Generated artifacts failed lint (regenerated schema not repo-style)"; exit 1; }
echo ""

# Step 5: Sync version
echo "→ Syncing version to $VERSION..."
bun scripts/version-sync.mjs "$VERSION"
echo ""

# Step 6: Commit (skip if versions were already at target)
echo "→ Committing version bump..."
git add -A
if git diff --cached --quiet; then
  echo "  (no changes — version already at $VERSION)"
else
  git commit -m "release: $TAG"
fi

# Step 7: Tag
echo "→ Creating tag $TAG..."
git tag -a "$TAG" -m "Release $TAG"
echo ""

# Step 8: Push
echo "→ Pushing to git remotes..."
if ! git remote | grep -qx origin; then
  echo "Error: no 'origin' remote configured"
  exit 1
fi
for remote in $(git remote); do
  if [[ "$remote" == "origin" ]]; then
    echo "  [$remote] (required)"
    git push "$remote" "$BRANCH" || { echo "Error: push to origin failed"; exit 1; }
    git push "$remote" "$TAG" || { echo "Error: tag push to origin failed"; exit 1; }
  else
    echo "  [$remote] (best-effort mirror)"
    git push "$remote" "$BRANCH" "$TAG" 2>&1 || \
      echo "  ⚠ Warning: could not push to '$remote' — push it manually when its credentials are available"
  fi
done
echo ""

# Step 9: Publish the public packages to npm.
#
# Build explicitly, then publish with --ignore-scripts so the npm-registry path
# and the NPM_PUBLISH_URL path ship byte-identical artifact sets (packages carry
# a prepublishOnly build that would otherwise run a second, redundant build).
publish_package() {
  local dir="$1" name pkg_version packdir tarball http_code response_file
  name=$(node -p "require('./$dir/package.json').name")
  pkg_version=$(node -p "require('./$dir/package.json').version")

  echo "  [$name@$pkg_version] building..."
  bun run --cwd "$dir" build >/dev/null 2>&1 || { echo "Error: build failed for $name"; exit 1; }

  # Pack into a temp dir, never in-tree: a tarball left inside the repo would be
  # picked up by the next release's `git add -A` and committed.
  packdir=$(mktemp -d)
  ( cd "$dir" && npm pack --pack-destination "$packdir" --silent >/dev/null 2>&1 ) \
    || { echo "Error: npm pack failed for $name"; rm -rf "$packdir"; exit 1; }
  tarball=$(ls "$packdir"/*.tgz 2>/dev/null | head -1)
  [[ -n "$tarball" ]] || { echo "Error: no tarball produced for $name"; rm -rf "$packdir"; exit 1; }

  if [[ -n "${NPM_PUBLISH_URL:-}" ]]; then
    echo "  [$name@$pkg_version] POST $NPM_PUBLISH_URL"
    response_file=$(mktemp)
    # `|| http_code=000` keeps `set -e` from aborting before we can report why.
    http_code=$(curl -s -o "$response_file" -w '%{http_code}' \
      -X POST --data-binary "@$tarball" \
      -H 'Content-Type: application/octet-stream' \
      "$NPM_PUBLISH_URL" || echo '000')
    if [[ "$http_code" != "200" ]]; then
      echo "Error: publish failed for $name (HTTP $http_code)"
      cat "$response_file" 2>/dev/null; echo
      rm -f "$response_file"; rm -rf "$packdir"
      exit 1
    fi
    rm -f "$response_file"
  else
    echo "  [$name@$pkg_version] npm publish --access public"
    ( cd "$dir" && npm publish "$tarball" --access public --ignore-scripts ) || {
      echo "Error: npm publish failed for $name (are you logged in? check 'npm whoami')"
      rm -rf "$packdir"
      exit 1
    }
  fi

  rm -rf "$packdir"
  echo "  ✓ published $name@$pkg_version"
}

if [[ "$NO_PUBLISH" == "--no-publish" ]]; then
  echo "→ Skipping npm publish (--no-publish)."
else
  echo "→ Publishing to npm..."
  publish_package "$PI_DIR"
  publish_package "$CLI_DIR"
fi
echo ""

echo "  ✓ Released $TAG"
if [[ "$NO_PUBLISH" == "--no-publish" ]]; then
  echo "  → npm publish was skipped (--no-publish)"
  echo "  → Publish manually: @ufoq/pi-mini-magic-context@$VERSION, @ufoq/mini-magic-context@$VERSION"
else
  echo "  → Published: @ufoq/pi-mini-magic-context@$VERSION, @ufoq/mini-magic-context@$VERSION"
fi
echo "  → https://github.com/ufoq/mini-magic-context/releases/tag/$TAG"
