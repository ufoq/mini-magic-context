#!/usr/bin/env bash
# Run the Pi docker E2E test image locally.
#
# Usage:
#   tests/docker/run-e2e.sh              # Pi
#
# Pre-requisite: run `bun run --cwd packages/pi-plugin build` first — the
# Dockerfile COPYs the pre-built dist/ tree rather than building in-image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="${1:-pi}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

run_target() {
    local harness="$1"
    local dockerfile="$SCRIPT_DIR/Dockerfile.$harness"
    local image="mc-e2e-$harness"

    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  Building $image image (linux/amd64)..."
    echo "════════════════════════════════════════════════════════════"
    docker build \
        --platform linux/amd64 \
        -f "$dockerfile" \
        -t "$image" \
        "$REPO_ROOT"

    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  Running $image..."
    echo "════════════════════════════════════════════════════════════"
    if docker run --rm --platform linux/amd64 "$image"; then
        echo -e "${GREEN}✓ $harness E2E PASSED${NC}"
        return 0
    else
        echo -e "${RED}✗ $harness E2E FAILED${NC}"
        return 1
    fi
}

# Pre-build local dists. The Dockerfiles COPY these — they don't build
# inside the image. This is intentional: keeps the image small, makes
# iteration fast, and tests the same artifact CI publishes.
echo "Pre-building local dist artifacts..."
bun run --cwd "$REPO_ROOT/packages/pi-plugin" build

# pi-plugin runtime deps are installed inside the Pi Docker image
# (see Dockerfile.pi) so better-sqlite3 builds against the correct
# linux/amd64 platform — no host install needed.

EXIT=0
case "$TARGET" in
    pi)
        run_target pi || EXIT=1
        ;;
    *)
        echo "Unknown target: $TARGET" >&2
        echo "Usage: $0 [pi]" >&2
        exit 2
        ;;
esac

echo ""
if [[ $EXIT -eq 0 ]]; then
    echo -e "${GREEN}All requested E2E targets passed.${NC}"
else
    echo -e "${RED}One or more E2E targets failed.${NC}"
fi
exit $EXIT
