import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));

/*
 * EVERYTHING that reaches a device path must be loaded with `await import()`
 * AFTER register(). Node resolves a module's STATIC imports at link time —
 * before any of its own top-level code runs — so a static import of a device
 * path (or of a src module that itself imports one) fails with
 * ERR_MODULE_NOT_FOUND no matter where register() sits in the file.
 */
const { createFramebuffer, drawContext } =
    await import(path.resolve(HERE, "../../schwung/tools/param-pages/harness.mjs"));
const { fontWidth4x5 } =
    await import("/data/UserData/schwung/shared/param_pages/font4x5.mjs");
const { drawPadsPage, drawKeysPage, ACTION_LABELS, KEY_ROWS, CELL_W, COL_X, KEY_W } =
    await import("../src/pad_map.mjs");

let bad = 0;
const fail = (m) => { console.error("FAIL " + m); bad++; };

/*
 * In this face nearly every three-letter word measures 14 or 15px against a
 * 14px budget, so a label that fits is luck unless it is measured. "NEW" is
 * 15 and is why pad 1 says GEN.
 */
for (const label of ACTION_LABELS) {
    if (!label) continue;
    const w = fontWidth4x5(label.toUpperCase());
    if (w > CELL_W - 2) fail("pad label " + label + " is " + w + "px, budget " + (CELL_W - 2));
}

/* Same discipline for the Keys columns: measure, do not eyeball. */
for (const row of KEY_ROWS) {
    row.forEach((pair, c) => {
        if (!pair) return;
        const kx = COL_X[c], ax = kx + KEY_W;
        const kEnd = kx + fontWidth4x5(pair[0].toUpperCase());
        const aEnd = ax + fontWidth4x5(pair[1].toUpperCase());
        const limit = (c === 0 && row.length > 1) ? COL_X[1] - 2 : 127;
        if (kEnd > ax - 1) fail("keys row: '" + pair[0] + "' runs into its action");
        if (aEnd > limit) fail("keys row: '" + pair[1] + "' runs past " + limit);
    });
}

function render(draw) {
    const fb = createFramebuffer();
    const ctx = drawContext(fb);
    fb.clearScreen();
    draw(fb, ctx);
    return fb;
}
const plain = render((fb, ctx) => drawPadsPage(fb, ctx, { shiftHeld: false }));
const shift = render((fb, ctx) => drawPadsPage(fb, ctx, { shiftHeld: true }));
const keys  = render((fb, ctx) => drawKeysPage(fb, ctx));

for (const [name, fb] of [["pads", plain], ["pads+shift", shift], ["keys", keys]]) {
    if (fb.clipped() !== 0) fail(name + " drew " + fb.clipped() + " px off-screen");
    if ([...fb.missingGlyphs].length) fail(name + " uses glyphs the device lacks");
}
if (Buffer.from(plain.pixels).equals(Buffer.from(shift.pixels))) {
    fail("the Shift variant is identical to the plain one");
}

if (bad) process.exit(1);
console.log("pad map ok");
