#!/usr/bin/env bash
# Host-side render tests. Needs the sibling schwung checkout and Node 20+.
set -euo pipefail
cd "$(dirname "$0")/.."
node tests/render.mjs "$@"
