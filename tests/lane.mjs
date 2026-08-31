import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createFramebuffer, drawContext } =
    await import(path.resolve(HERE, "../../schwung/tools/param-pages/harness.mjs"));
import { drawMiniLane, drawBigLane, REST, NOTE, ACCENT, SLIDE } from "../src/lane.mjs";

let bad = 0;
const fail = (m) => { console.error("FAIL " + m); bad++; };
const lit = (fb, x, y) => fb.pixels[y * fb.width + x] === 1;

/*
 * The crossbar of an H has to sit at a row where both uprights exist. Tie an
 * accent to a plain note and a pixel two below the ACCENT's head floats above
 * the note entirely, connecting nothing — and that case is invisible in a
 * pattern of even notes, so it is the one worth asserting.
 */
for (const [a, b, name] of [[ACCENT, NOTE, "accent->note"],
                            [NOTE, ACCENT, "note->accent"],
                            [NOTE, NOTE, "note->note"]]) {
    const fb = createFramebuffer();
    const ctx = drawContext(fb);
    fb.clearScreen();
    const steps = new Array(16).fill(REST);
    steps[0] = a; steps[1] = b;
    /* Slides are encoded as their own state, so tie step 0 by making it a
     * SLIDE whose height matches `a`. */
    drawMiniLane(fb, ctx, { steps: steps.map((s, i) => (i === 0 ? SLIDE : s)),
                            position: 8, heightOf: (i) => (i === 0 ? a : b) },
                 { x: 0, y: 57, w: 128, h: 7 });

    const cw = 128 / 16;
    const gapX = Math.round(cw) - 1;
    let found = -1;
    for (let y = 57; y < 64; y++) if (lit(fb, gapX, y)) found = y;
    if (found < 0) { fail(name + ": no connector drawn"); continue; }
    if (!lit(fb, gapX - 1, found)) fail(name + ": connector not touching the first bar");
    if (!lit(fb, gapX + 1, found)) fail(name + ": connector not touching the second bar");
    if (fb.clipped() !== 0) fail(name + ": drew " + fb.clipped() + " px off-screen");
}

/* The big lane must stay inside its rect. */
{
    const fb = createFramebuffer();
    const ctx = drawContext(fb);
    fb.clearScreen();
    const steps = [ACCENT, REST, NOTE, SLIDE, NOTE, REST, ACCENT, NOTE,
                   REST, NOTE, NOTE, REST, SLIDE, NOTE, REST, ACCENT];
    drawBigLane(fb, ctx, { steps, position: 6 }, { x: 0, y: 14, w: 128, h: 22 });
    if (fb.clipped() !== 0) fail("big lane drew " + fb.clipped() + " px off-screen");
    for (let y = 0; y < 14; y++) {
        for (let x = 0; x < 128; x++) if (lit(fb, x, y)) fail("big lane drew above its rect");
    }
}

if (bad) process.exit(1);
console.log("lane ok");
