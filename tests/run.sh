#!/usr/bin/env bash
# Host-side tests. Needs the sibling schwung checkout and Node 20+.
#
# The C unit runs FIRST: it compiles src/dsp/tb3po.c natively and exercises the
# bank/persistence code the .mjs tests cannot reach at all (they stub the DSP).
# A cross-compiler is not needed -- the plugin is included into the test binary
# and its entry points are called in-process, the same way the host calls them.
set -euo pipefail
cd "$(dirname "$0")/.."
make -C tests/c test
node tests/render.mjs "$@"
