import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

import { TB3PO_PARAMS, PAGE_PATTERN, ringFor } from "../src/params.mjs";
/*
 * Node resolves a module's own static imports at link time, before any of
 * its top-level code (including the register() call above) has run — so a
 * static import of the device path here would race the hook and always
 * lose. A dynamic import happens after link time, once register() has
 * already taken effect, which is exactly the pattern tests/render.mjs uses
 * to reach the sibling schwung checkout.
 */
const { buildMetaIndex } =
    await import("/data/UserData/schwung/shared/param_pages/param_meta.mjs");

let bad = 0;
const fail = (m) => { console.error("FAIL " + m); bad++; };

const meta = buildMetaIndex({ chainParams: TB3PO_PARAMS });
if (meta.getOrGuess("density").kind !== "number") fail("density is not a number");
if (meta.getOrGuess("scale").kind !== "enum") fail("scale is not an enum");

if (ringFor({ has303: true }).length !== 6) fail("ring with a 303 is not 6 pages");
const without = ringFor({ has303: false });
if (without.length !== 5) fail("ring without a 303 is not 5 pages");
if (without.some((p) => p.name === "303")) fail("303 page present with no 303 loaded");

const row0 = PAGE_PATTERN.keys.slice(0, 4).join(",");
if (row0 !== "density,accent,slide,gate") fail("Pattern row 0 is " + row0);

/* Every key a page names must be declared, or the grid invents a
 * float 0..1 knob and writes 0.058750 into an enum. */
const declared = new Set(TB3PO_PARAMS.map((p) => p.key));
for (const page of ringFor({ has303: true })) {
    for (const k of (page.keys || [])) {
        if (k && !declared.has(k)) fail("page " + page.name + " names undeclared key " + k);
    }
}

if (bad) process.exit(1);
console.log("params ok");
