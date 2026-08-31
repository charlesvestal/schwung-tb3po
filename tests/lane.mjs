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
 *
 * `heightOf` is a test-only seam: production never produces an ACCENT-height
 * SLIDE (step states are mutually exclusive — cycleStepState cycles
 * rest -> note -> accent -> slide, so a slide is never accented). The seam
 * lets this case exist anyway so the max()-of-two-heads arithmetic gets
 * pinned in both directions; it does not mean slides can be accented.
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

/*
 * A pattern can be 8/16/24/32 steps; the screen only shows 16 at a time. A
 * 32-step pattern with stepBase:16 must draw the SECOND half, not the first
 * 16 steps again.
 */
{
    const steps = new Array(32).fill(REST);
    steps[0] = ACCENT;   // column 0 of the first window only; step 16 (column 0
                         // of the second window) stays REST, so the two windows
                         // must draw differently at the same screen column.

    // position: -1 (no playhead in either window) so the only thing that can
    // light up column 0's bar rows is the step data itself.
    const firstFb = createFramebuffer();
    drawBigLane(firstFb, drawContext(firstFb), { steps, position: -1, stepBase: 0 },
                { x: 0, y: 14, w: 128, h: 22 });
    const secondFb = createFramebuffer();
    drawBigLane(secondFb, drawContext(secondFb), { steps, position: -1, stepBase: 16 },
                { x: 0, y: 14, w: 128, h: 22 });

    // Column 0 (x=2..6) should have an accent-height bar in the first window,
    // nothing in the second. Bar rows only (14..29); the playhead/beat-tick
    // band starts at base+1 (=31), so this range can't pick those up.
    const litInCol0 = (fb) => { for (let y = 14; y < 30; y++) if (lit(fb, 3, y)) return true; return false; };
    if (!litInCol0(firstFb)) fail("window: first window did not draw its own step 0");
    if (litInCol0(secondFb)) fail("window: second window drew content from step 0, which is outside it");
}

/* The playhead must appear only when it falls inside the drawn window. */
{
    const steps = new Array(32).fill(NOTE);
    const rect = { x: 0, y: 14, w: 128, h: 22 };
    const base = rect.y + rect.h - 6;

    const insideFb = createFramebuffer();
    drawBigLane(insideFb, drawContext(insideFb), { steps, position: 20, stepBase: 16 }, rect);
    const outsideFb = createFramebuffer();
    drawBigLane(outsideFb, drawContext(outsideFb), { steps, position: 20, stepBase: 0 }, rect);

    const playheadAt = (fb, col) => lit(fb, rect.x + col * 8 + 1, base + 2);
    if (!playheadAt(insideFb, 4)) fail("window: playhead missing when position is inside the window");
    // position=20 relative to stepBase=0 is column 20 -- off both the rect and
    // the canvas. The guard must suppress the draw, not let it clip off-screen.
    if (outsideFb.clipped() !== 0) fail("window: playhead drawn off-canvas when position (20) is outside window [0,16)");
    if (playheadAt(outsideFb, 4)) fail("window: playhead drawn when position (20) is outside window [0,16)");
}

if (bad) process.exit(1);
console.log("lane ok");
