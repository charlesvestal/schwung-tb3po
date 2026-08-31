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
/* pages.mjs imports the shared library by device path, so it too must come
 * in dynamically — the transitive import is resolved at the same link time. */
const { drawPage } = await import("../src/pages.mjs");
const { ringFor, PAGE_PATTERN } = await import("../src/params.mjs");
const { REST, NOTE, ACCENT, SLIDE } = await import("../src/lane.mjs");

let bad = 0;
const fail = (m) => { console.error("FAIL " + m); bad++; };

const view = {
    slotLabel: "Slot A", bpm: 124, shiftHeld: false, touched: -1,
    steps: [ACCENT, REST, NOTE, SLIDE, NOTE, REST, ACCENT, NOTE,
            REST, NOTE, NOTE, REST, SLIDE, NOTE, REST, ACCENT],
    position: 6,
    values: { density: 0.72, accent: 0.4, slide: 0.25, gate: 0.55,
              root: 9, scale: 0, length: 1, octaves: 2,
              "303.cutoff": 96, "303.resonance": 74, "303.decay": 58, "303.env_mod": 88,
              "303.accent": 64, "303.volume": 100, "303.drive": 30, "303.drive_mix": 45,
              channel: 1, direction: 0, transpose: 0, current_bank: 3 },
};

const ring = ringFor({ has303: true });
if (ring.length !== 6) fail("ring is not 6 pages");

const litRows = (fb, y0, y1) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = 0; x < 128; x++) if (fb.pixels[y * 128 + x]) n++;
    return n;
};

ring.forEach((page, i) => {
    const fb = createFramebuffer();
    const ctx = drawContext(fb);
    fb.clearScreen();
    drawPage(fb, ctx, { ...view, ring, pageIndex: i });
    if (fb.clipped() !== 0) fail(page.name + " drew " + fb.clipped() + " px off-screen");
    if ([...fb.missingGlyphs].length) fail(page.name + " uses glyphs the device lacks");
    /* The footer band carries the lane on every page but PERFORM. */
    const footerLit = litRows(fb, 57, 63);
    if (page.kind === "perform") {
        if (footerLit === 0) fail("PERFORM has an empty footer");
    } else if (footerLit === 0) {
        fail(page.name + " has no footer lane");
    }
});

/* PERFORM's row must be Pattern's row 0, not a copy of it. */
if (PAGE_PATTERN.keys.slice(0, 4).join(",") !== "density,accent,slide,gate") {
    fail("Pattern row 0 changed without PERFORM following it");
}

if (bad) process.exit(1);
console.log("pages ok");
