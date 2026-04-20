#!/usr/bin/env bash
# Build TB-3PO module for Schwung.
# Uses Docker to cross-compile the DSP for aarch64; falls back to CROSS_PREFIX if set.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

IMAGE_NAME="tb3po-builder"
MODULE_ID="tb3po"
DIST_DIR="dist/${MODULE_ID}"
TARBALL="dist/${MODULE_ID}-module.tar.gz"

# Re-invoke inside Docker unless we're already there (or CROSS_PREFIX set).
if [ -z "${CROSS_PREFIX:-}" ] && [ ! -f "/.dockerenv" ]; then
    echo "=== TB-3PO build (via Docker) ==="
    if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
        echo "Building Docker image..."
        docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT"
    fi
    docker run --rm \
        -v "$REPO_ROOT:/build" \
        -u "$(id -u):$(id -g)" \
        -w /build \
        "$IMAGE_NAME" \
        ./scripts/build.sh
    exit 0
fi

# Actual build (in Docker or with native cross-compiler).
CROSS_PREFIX="${CROSS_PREFIX:-aarch64-linux-gnu-}"
CC="${CC:-${CROSS_PREFIX}gcc}"

rm -rf dist build
mkdir -p "$DIST_DIR" build

echo "Compiling DSP..."
"$CC" \
    -O2 -Wall -Wextra -Wno-unused-parameter \
    -fPIC -shared \
    -o build/dsp.so \
    src/dsp/tb3po.c

# ExtFS-mounted volumes on macOS reject close/dealloc after cp/install;
# writing via cat through a fresh fd works around it.
cat build/dsp.so > "$DIST_DIR/dsp.so"
chmod 0755 "$DIST_DIR/dsp.so"
cat src/module.json > "$DIST_DIR/module.json"
cat src/ui.js > "$DIST_DIR/ui.js"
[ -f src/help.json ] && cat src/help.json > "$DIST_DIR/help.json" || true

(cd dist && tar -czf "${MODULE_ID}-module.tar.gz" "${MODULE_ID}/")

echo "Built: $TARBALL"
ls -lh "$TARBALL"
file "$DIST_DIR/dsp.so"
