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
const { pagesFor, PAGE_PATTERN, controllerPageFor } = await import("../src/params.mjs");
const { REST, NOTE, ACCENT, SLIDE } = await import("../src/lane.mjs");
const { makeController } = await import("./fixture_ctl.mjs");
const { BODY, BANDS } = await import("../src/pages.mjs");
const { movyBandLayout, BAND_H } =
    await import("/data/UserData/schwung/shared/param_pages/render_page_movy.mjs");

let bad = 0;
const fail = (m) => { console.error("FAIL " + m); bad++; };

const { ctl } = makeController({ has303: true });

const view = {
    slotLabel: "Slot A", bpm: 124, shiftHeld: false, touched: -1,
    steps: [ACCENT, REST, NOTE, SLIDE, NOTE, REST, ACCENT, NOTE,
            REST, NOTE, NOTE, REST, SLIDE, NOTE, REST, ACCENT],
    position: 6, stepView: 0, ctl,
};

const pages = pagesFor({ has303: true });
if (pages.length !== 6) fail("pages is not 6 pages");

/*
 * THE OUTER PAGE SET AND THE CONTRACT MUST AGREE ON WHAT EXISTS.
 *
 * The hierarchy is the sole definition of which cells are reachable and it
 * fails SILENTLY -- drop a key and the page is simply planned one cell
 * shorter, with no orphan page and no warning. tests/params.mjs asserts the
 * key coverage; this asserts the PAGE coverage, which is the other half: one
 * planned knob page per outer knob page, in the same order.
 */
{
    const outerKnobs = pages.filter((p) => p.kind === "knobs");
    if (ctl.pages.length !== outerKnobs.length) {
        fail("the contract plans " + ctl.pages.length + " knob pages for " +
             outerKnobs.length + " outer knob pages");
    }
    for (let i = 0; i < pages.length; i++) {
        const target = controllerPageFor(pages, i);
        const want = pages[i].kind === "knobs" || pages[i].kind === "perform";
        if (want && !(target >= 0 && target < ctl.pages.length)) {
            fail(pages[i].name + " maps to controller page " + target);
        }
        if (!want && target !== -1) fail(pages[i].name + " should map to no controller page");
    }
}

/*
 * THE BODY RECT PUTS THE ROWS WHERE THE DEVICE DRAWS THEM.
 *
 * With every chrome band stood down the layout CLOSES UP, so `rect.y` is not
 * the row -- the first row lands one gutter below it. Passing ROW0_Y (9) gives
 * [[10,25],[34,49]], one pixel low, which is the kind of drift nobody sees in
 * a screenshot and everybody sees on hardware next to a footer that did not
 * move. Asserted against the vertical rhythm's own numbers rather than
 * against four literals.
 */
{
    const L = movyBandLayout({ rect: BODY, bands: BANDS });
    const got = L.rows.map((r) => [r.rowY, r.lblY]);
    const want = JSON.stringify([[9, 24], [33, 48]]);
    if (JSON.stringify(got) !== want) {
        fail("BODY rect puts the knob rows at " + JSON.stringify(got) + ", want " + want);
    }
    if (L.header !== null || L.bank !== null || L.footer !== null) {
        fail("BANDS still lays out chrome TB-3PO draws itself");
    }
    if (!L.fits) fail("the body does not fit BODY: dropped " + L.dropped.join(","));
    if (BODY.y !== 9 - BAND_H.gutter0) {
        fail("BODY.y is not ROW0_Y minus the first gutter");
    }
}

const litRows = (fb, y0, y1) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = 0; x < 128; x++) if (fb.pixels[y * 128 + x]) n++;
    return n;
};

pages.forEach((page, i) => {
    const fb = createFramebuffer();
    const ctx = drawContext(fb);
    fb.clearScreen();
    const target = controllerPageFor(pages, i);
    if (target >= 0) ctl.goToPage(target);
    drawPage(fb, ctx, { ...view, pages, pageIndex: i });
    if (fb.clipped() !== 0) fail(page.name + " drew " + fb.clipped() + " px off-screen");
    if ([...fb.missingGlyphs].length) fail(page.name + " uses glyphs the device lacks");
    if (litRows(fb, 57, 63) === 0) fail(page.name + " has an empty footer");
});

/*
 * Whether the footer holds a LANE, distinguished from whether it holds
 * anything at all.
 *
 * "the band has lit pixels" passes on hint text, so it cannot tell a lane from
 * a footer that never got one -- which is exactly the bug it was written to
 * catch. A lane MOVES: render the same page at two playhead positions and the
 * band must differ. Hint text is identical either way, so the same probe
 * proves the negative for Pads and Keys.
 */
function footerAt(page, i, position) {
    const fb = createFramebuffer();
    const ctx = drawContext(fb);
    fb.clearScreen();
    const target = controllerPageFor(pages, i);
    if (target >= 0) ctl.goToPage(target);
    drawPage(fb, ctx, { ...view, pages, pageIndex: i, position });
    return Buffer.from(fb.pixels.slice(57 * 128, 64 * 128)).toString("hex");
}
pages.forEach((page, i) => {
    if (page.kind === "perform") return;
    const moved = footerAt(page, i, 2) !== footerAt(page, i, 9);
    const wantsLane = page.kind === "knobs";
    if (wantsLane && !moved) fail(page.name + ": footer does not track the playhead — no lane");
    if (!wantsLane && moved) fail(page.name + ": footer changed with the playhead but should be hints");
});

/* PERFORM's row must be Pattern's row 0, not a copy of it. */
if (PAGE_PATTERN.keys.slice(0, 4).join(",") !== "density,accent,slide,gate") {
    fail("Pattern row 0 changed without PERFORM following it");
}

if (bad) process.exit(1);
console.log("pages ok");
