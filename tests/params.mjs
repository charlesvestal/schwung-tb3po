import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TB3PO_PARAMS, PAGE_PATTERN, pagesFor, hierarchyFor } from "../src/params.mjs";
/* Dynamic, not static: see the note in Task 4. params.mjs itself is pure data
 * with no device imports, so it may stay static. */
const { buildMetaIndex, isReadOnly } =
    await import("/data/UserData/schwung/shared/param_pages/param_meta.mjs");
const { planPages } =
    await import("/data/UserData/schwung/shared/param_pages/page_plan.mjs");

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
 * ===================== THE HIERARCHY IS THE ONLY DEFINITION =====================
 *
 * `keyForKnob` used to read a page's key list directly, so a key could not be
 * lost: the page object WAS the answer. The shared controller plans from
 * `ui_hierarchy` instead, which makes that declaration the sole statement of
 * what is reachable -- and it fails SILENTLY. Dropping `transpose` and
 * `current_bank` from the Setup level leaves a page planned with two cells:
 * the params simply vanish. No orphan page, no warning, no error, nothing on
 * screen that reads as wrong.
 *
 * So every declared param must land on some planned page, and it is asserted
 * for BOTH shapes of the contract -- the 303 level is conditional, and a key
 * reachable only when a 303 happens to be loaded is the same defect wearing a
 * precondition. `303.*` keys are excused in the no-303 shape, and only those.
 *
 * Proven by mutation: remove any key from the `knobs` array `hierarchyFor`
 * builds and this fails naming it; the rest of the suite stays green.
 */
for (const has303 of [true, false]) {
    const planned = planPages({
        hierarchy: hierarchyFor({ has303 }), chainParams: TB3PO_PARAMS,
    });
    if (planned.warnings.length) {
        fail("planning the contract (has303=" + has303 + ") warned: " +
             planned.warnings.join("; "));
    }
    const placed = new Set();
    for (const page of planned.pages) {
        for (const k of (page.keys || [])) if (k) placed.add(k);
    }
    for (const p of TB3PO_PARAMS) {
        const is303 = p.key.startsWith("303.");
        if (is303 && !has303) {
            if (placed.has(p.key)) fail("303 key " + p.key + " is planned with no 303 loaded");
            continue;
        }
        if (!placed.has(p.key)) {
            fail("declared param " + p.key + " lands on NO planned page (has303=" +
                 has303 + ") -- the hierarchy dropped it silently");
        }
    }
    /* ...and nothing is planned that was never declared, which is the same
     * failure pointing the other way: a knob that turns and changes nothing. */
    const declaredKeys = new Set(TB3PO_PARAMS.map((p) => p.key));
    for (const k of placed) {
        if (!declaredKeys.has(k)) fail("planned key " + k + " is not declared");
    }
    /* The pages come out in the order pagesFor() puts them, which is what lets
     * one index map onto the other -- see controllerPageFor. */
    const names = pagesFor({ has303 }).filter((p) => p.kind === "knobs").length;
    if (planned.pages.length !== names) {
        fail("has303=" + has303 + ": " + planned.pages.length +
             " planned pages against " + names + " outer knob pages");
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
