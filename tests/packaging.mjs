/*
 * scripts/build.sh must ship every sibling ES module.
 *
 * The redesign split src/ui.js's drawing into src/params.mjs, lane.mjs,
 * pad_map.mjs and pages.mjs. build.sh copies files by an explicit list, not
 * a glob -- so adding a fifth module later and forgetting to add it to that
 * list produces a module that installs cleanly and fails at IMPORT time on
 * the device (this is how v0.2.7 shipped). This test can't stop someone
 * from forgetting the edit, but it stops the forgotten edit from passing CI
 * silently: it reads the real source tree and the real build.sh, and fails
 * the moment they disagree.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

const srcFiles = readdirSync(path.join(repoRoot, "src"))
    .filter((f) => f === "ui.js" || f.endsWith(".mjs"))
    .sort();

const buildScript = readFileSync(path.join(repoRoot, "scripts/build.sh"), "utf8");

let bad = false;
function fail(msg) {
    bad = true;
    console.error("FAIL: " + msg);
}

if (srcFiles.length === 0) {
    fail("found no src/ui.js or src/*.mjs -- the repo layout changed under this test");
}

for (const f of srcFiles) {
    /* Word-boundary match against the copy loop's `for f in ...; do` list --
     * a bare substring match would let "pages.mjs" satisfy a hypothetical
     * "old_pages.mjs" entry. */
    const re = new RegExp("(^|[^A-Za-z0-9_.-])" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^A-Za-z0-9_.-]|$)");
    if (!re.test(buildScript)) {
        fail(`src/${f} is not named anywhere in scripts/build.sh -- it will not reach dist/ or the tarball`);
    }
}

if (bad) process.exit(1);
console.log(`packaging ok (${srcFiles.length} files: ${srcFiles.join(", ")})`);
