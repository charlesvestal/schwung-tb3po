#!/usr/bin/env bash
# Install TB-3PO onto a Move device over SSH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

MOVE_HOST="${MOVE_HOST:-ableton@move.local}"
MODULE_ID="tb3po"
SRC_DIR="dist/${MODULE_ID}"
DEST_DIR="/data/UserData/schwung/modules/tools/${MODULE_ID}"

if [ ! -d "$SRC_DIR" ]; then
    echo "dist/${MODULE_ID} missing — run scripts/build.sh first"
    exit 1
fi

echo "Installing to $MOVE_HOST:$DEST_DIR ..."
ssh "$MOVE_HOST" "mkdir -p '$DEST_DIR'"
scp -r "$SRC_DIR"/* "$MOVE_HOST:$DEST_DIR/"
echo "Done. Open Tools menu on Move to load TB-3PO."
