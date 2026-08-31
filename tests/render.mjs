/*
 * Renders every TB-3PO page into the real device framebuffer and asserts the
 * two things a layout can get wrong without anyone noticing on hardware: a
 * pixel drawn off the edge (silently discarded by the device) and a glyph the
 * ASCII atlas cannot draw (silently renders as nothing).
 */
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const harness = await import(
    path.resolve(HERE, "../../schwung/tools/param-pages/harness.mjs"));

const SNAP_DIR = path.join(HERE, "snapshots");
const UPDATE = process.argv.includes("--update");
const STRICT = process.env.TB3PO_SNAPSHOTS_STRICT === "1";

let failures = 0;
let rendered = 0;
let created = 0;

export function renderCase(name, draw) {
    const fb = harness.createFramebuffer();
    const ctx = harness.drawContext(fb);
    fb.clearScreen();

    try {
        draw(fb, ctx);
    } catch (err) {
        console.error("FAIL " + name + ": threw " + (err && err.message ? err.message : err));
        failures++;
        return;
    }
    rendered++;

    if (fb.clipped() !== 0) {
        console.error("FAIL " + name + ": " + fb.clipped() + " pixels drawn off-screen");
        failures++;
    }
    const missing = [...fb.missingGlyphs];
    if (missing.length) {
        console.error("FAIL " + name + ": glyphs the device cannot draw: " + missing.join(" "));
        failures++;
    }

    const snapPath = path.join(SNAP_DIR, name + ".txt");
    const blocks = fb.toBlocks();
    const exists = fs.existsSync(snapPath);
    if (UPDATE) {
        fs.writeFileSync(snapPath, blocks);
    } else if (!exists) {
        if (STRICT) {
            console.error("FAIL " + name + ": no snapshot baseline and TB3PO_SNAPSHOTS_STRICT=1");
            failures++;
        } else {
            fs.writeFileSync(snapPath, blocks);
            console.log("NEW baseline " + name + " — review tests/snapshots/" + name + ".png before committing");
            created++;
        }
    } else if (fs.readFileSync(snapPath, "utf8") !== blocks) {
        console.error("FAIL " + name + ": snapshot differs — rerun with --update if intended");
        failures++;
    }
    fs.writeFileSync(path.join(SNAP_DIR, name + ".png"), fb.toPng(4));
}

export async function main(cases) {
    failures = 0;
    rendered = 0;
    created = 0;
    for (const [name, draw] of cases) renderCase(name, draw);
    if (failures === 0) {
        console.log("harness ok — " + rendered + " pages");
    } else {
        console.log("rendered " + rendered + " pages");
        console.error(failures + " failure(s)");
    }
    return failures;
}

const { drawPage } = await import("../src/pages.mjs");
const { pagesFor, controllerPageFor } = await import("../src/params.mjs");
const { REST, NOTE, ACCENT, SLIDE } = await import("../src/lane.mjs");
const { makeController } = await import("./fixture_ctl.mjs");

/*
 * A REAL CONTROLLER, because the controller is what draws a knob page now.
 *
 * A fixture that hands `drawPage` a bare `values` map no longer renders a
 * simpler grid -- it renders NO grid, and every one of these snapshots would
 * quietly become a picture of the chrome alone. See tests/fixture_ctl.mjs.
 */
const { ctl } = makeController({ has303: true });

const VIEW = {
    slotLabel: "Slot A", bpm: 124, shiftHeld: false, touched: -1,
    steps: [ACCENT, REST, NOTE, SLIDE, NOTE, REST, ACCENT, NOTE,
            REST, NOTE, NOTE, REST, SLIDE, NOTE, REST, ACCENT],
    position: 6, stepView: 0, ctl,
};

const pages = pagesFor({ has303: true });

/*
 * Put the controller in the state ui.js would have put it in, then draw.
 *
 * TWO things, and neither is optional. The page, because the outer index and
 * the controller's are not the same number (syncController). And the TOUCH,
 * because a held knob is the controller's state -- `view.touched` only tells
 * TB-3PO's chrome which knob to name in the header, while the INVERTED CELL is
 * drawn by the controller's own body from `state.touchOrder`. Setting one
 * without the other renders a header that says a knob is held above a grid
 * that says none is, which is what the first version of this fixture did.
 */
function draw(fb, ctx, view) {
    const target = controllerPageFor(view.pages, view.pageIndex);
    if (target >= 0) view.ctl.goToPage(target);
    view.ctl.clearTouch();
    if (view.touched >= 0) view.ctl.onKnobTouch(view.touched, true);
    drawPage(fb, ctx, view);
}

const cases = pages.map((page, i) =>
    [page.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
     (fb, ctx) => draw(fb, ctx, { ...VIEW, pages, pageIndex: i })]);

/* The states a static walk of the pages cannot reach. */
cases.push(["pads-shift", (fb, ctx) =>
    draw(fb, ctx, { ...VIEW, pages, pageIndex: 4, shiftHeld: true })]);
/*
 * A HELD KNOB TAKES THE HEADER OVER, and on a knob page that strip is the
 * controller's -- which TB-3PO has switched off (`bands.header: false`). So it
 * has to be redrawn from `movyHeaderFor`, or the header would go on saying
 * "Pattern" through the whole gesture. These two are the pin: one on each of
 * the two pages the controller draws, so a page that lost the readout cannot
 * hide behind one that kept it.
 */
cases.push(["pattern-touched", (fb, ctx) =>
    draw(fb, ctx, { ...VIEW, pages, pageIndex: 1, touched: 1 })]);
cases.push(["303-touched", (fb, ctx) =>
    draw(fb, ctx, { ...VIEW, pages, pageIndex: 2, touched: 5 })]);
/* ...and on PERFORM, whose row is drawn by TB-3PO rather than by the
 * controller's body, so it is a third draw path and not a repeat. */
cases.push(["steps-touched", (fb, ctx) =>
    draw(fb, ctx, { ...VIEW, pages, pageIndex: 0, touched: 2 })]);
/* The dive affordance and the picker it opens — rendered and eyeballed when
 * they were built, but nothing pinned them, so a footer that stopped offering
 * the dive would have been a silent regression. */
cases.push(["setup-divable-held", (fb, ctx) =>
    draw(fb, ctx, { ...VIEW, pages, pageIndex: 3, touched: 1 })]);

/* And the pages one page short, which is what no 303 loaded looks like. The
 * contract loses its 303 LEVEL too, so this needs its own controller: the
 * page set is the plan, and planning it from a hierarchy that still declares
 * the 303 would be testing a state the device never reaches. */
const short = pagesFor({ has303: false });
const shortCtl = makeController({ has303: false }).ctl;
cases.push(["no-303-ring", (fb, ctx) =>
    draw(fb, ctx, { ...VIEW, ctl: shortCtl, pages: short, pageIndex: 0 })]);

/*
 * The window work landed after the plan's case list was written: a 32-step
 * pattern has a second 16-step window, on both the big lane (PERFORM, follows
 * the user's stepView) and the mini lane (Pattern's footer, follows the
 * playhead — see windowFor in lane.mjs). position: 20 sits inside window 1
 * (steps 17-32) on the mini lane, independent of stepView.
 */
const STEPS32 = [
    ACCENT, REST, NOTE, SLIDE, NOTE, REST, ACCENT, NOTE,
    REST, NOTE, NOTE, REST, SLIDE, NOTE, REST, ACCENT,
    NOTE, REST, SLIDE, NOTE, ACCENT, REST, NOTE, NOTE,
    REST, ACCENT, NOTE, SLIDE, NOTE, REST, NOTE, ACCENT,
];
const VIEW32 = { ...VIEW, steps: STEPS32 };
const CTL32 = makeController({ has303: true, values: { length: "32 Steps" } }).ctl;
cases.push(["perform-window2", (fb, ctx) =>
    draw(fb, ctx, { ...VIEW32, ctl: CTL32, pages, pageIndex: 0, stepView: 1, position: 20 })]);
cases.push(["pattern-window2", (fb, ctx) =>
    draw(fb, ctx, { ...VIEW32, ctl: CTL32, pages, pageIndex: 1, position: 20 })]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const failCount = await main(cases);
    if (failCount) process.exit(1);
}
