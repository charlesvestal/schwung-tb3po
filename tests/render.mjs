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
const { ringFor } = await import("../src/params.mjs");
const { REST, NOTE, ACCENT, SLIDE } = await import("../src/lane.mjs");

const VIEW = {
    slotLabel: "Slot A", bpm: 124, shiftHeld: false, touched: -1,
    steps: [ACCENT, REST, NOTE, SLIDE, NOTE, REST, ACCENT, NOTE,
            REST, NOTE, NOTE, REST, SLIDE, NOTE, REST, ACCENT],
    position: 6, stepView: 0,
    values: { density: 0.72, accent: 0.4, slide: 0.25, gate: 0.55,
              root: 9, scale: 0, length: 1, octaves: 2,
              "303.cutoff": 96, "303.resonance": 74, "303.decay": 58, "303.env_mod": 88,
              "303.accent": 64, "303.volume": 100, "303.drive": 30, "303.drive_mix": 45,
              /* channel is an INDEX now, not a number: 0 renders as "1". The
               * fixture said 1 and the Setup page drew "2". */
              channel: 0, direction: 0, transpose: 0, current_bank: 3 },
};

const ring = ringFor({ has303: true });
const cases = ring.map((page, i) =>
    [page.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
     (fb, ctx) => drawPage(fb, ctx, { ...VIEW, ring, pageIndex: i })]);

/* The states a static walk of the ring cannot reach. */
cases.push(["pads-shift", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW, ring, pageIndex: 4, shiftHeld: true })]);
cases.push(["pattern-touched", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW, ring, pageIndex: 1, touched: 1 })]);
/* And the ring one page short, which is what no 303 loaded looks like. */
/* The dive affordance and the picker it opens — rendered and eyeballed when
 * they were built, but nothing pinned them, so a footer that stopped offering
 * the dive would have been a silent regression. */
cases.push(["setup-divable-held", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW, ring, pageIndex: 3, touched: 1 })]);

const short = ringFor({ has303: false });
cases.push(["no-303-ring", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW, ring: short, pageIndex: 0 })]);

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
const VIEW32 = { ...VIEW, steps: STEPS32, values: { ...VIEW.values, length: 3 } };
cases.push(["perform-window2", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW32, ring, pageIndex: 0, stepView: 1, position: 20 })]);
cases.push(["pattern-window2", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW32, ring, pageIndex: 1, position: 20 })]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const failCount = await main(cases);
    if (failCount) process.exit(1);
}
