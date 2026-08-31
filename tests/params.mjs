import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TB3PO_PARAMS, PAGE_PATTERN, pagesFor } from "../src/params.mjs";
/* Dynamic, not static: see the note in Task 4. params.mjs itself is pure data
 * with no device imports, so it may stay static. */
const { buildMetaIndex, isReadOnly } =
    await import("/data/UserData/schwung/shared/param_pages/param_meta.mjs");

let bad = 0;
const fail = (m) => { console.error("FAIL " + m); bad++; };

const meta = buildMetaIndex({ chainParams: TB3PO_PARAMS });
if (meta.getOrGuess("density").kind !== "number") fail("density is not a number");
if (meta.getOrGuess("scale").kind !== "enum") fail("scale is not an enum");

if (pagesFor({ has303: true }).length !== 6) fail("pages with a 303 is not 6 pages");
const without = pagesFor({ has303: false });
if (without.length !== 5) fail("pages without a 303 is not 5 pages");
if (without.some((p) => p.name === "303")) fail("303 page present with no 303 loaded");

const row0 = PAGE_PATTERN.keys.slice(0, 4).join(",");
if (row0 !== "density,accent,slide,gate") fail("Pattern row 0 is " + row0);

/* Every key a page names must be declared, or the grid invents a
 * float 0..1 knob and writes 0.058750 into an enum. */
const declared = new Set(TB3PO_PARAMS.map((p) => p.key));
for (const page of pagesFor({ has303: true })) {
    for (const k of (page.keys || [])) {
        if (k && !declared.has(k)) fail("page " + page.name + " names undeclared key " + k);
    }
}

/*
 * Every declared "303.<x>" key must, with the prefix stripped, be one of the
 * real param names the 303 plugin answers to -- CC_303_PARAM_KEYS in ui.js.
 * Read it out of ui.js at test time rather than hard-coding a second copy: a
 * copy is exactly how the two drift apart again (this review found four that
 * already had).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = fs.readFileSync(path.join(HERE, "../src/ui.js"), "utf8");
const cc303Match = uiSrc.match(/CC_303_PARAM_KEYS\s*=\s*\[([\s\S]*?)\]/);
if (!cc303Match) {
    fail("could not find CC_303_PARAM_KEYS in src/ui.js");
} else {
    const cc303Keys = new Set(
        [...cc303Match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    );
    for (const p of TB3PO_PARAMS) {
        if (!p.key.startsWith("303.")) continue;
        const stripped = p.key.slice("303.".length);
        if (!cc303Keys.has(stripped)) {
            fail("declared key " + p.key + " strips to " + stripped +
                 ", which is not in CC_303_PARAM_KEYS");
        }
    }
}

/*
 * current_bank is a READOUT, not a control: the DSP has no plain bank
 * setter, only current_bank (read-only). Dropping `access: "read"` from the
 * declaration would silently regress it into an ordinary dial that writes a
 * param the DSP rejects, with no visible symptom anywhere else.
 */
if (!isReadOnly(meta.getOrGuess("current_bank"))) {
    fail("current_bank is not read-only");
}

if (bad) process.exit(1);
console.log("params ok");
