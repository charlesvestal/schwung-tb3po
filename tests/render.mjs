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
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const harness = await import(
    path.resolve(HERE, "../../schwung/tools/param-pages/harness.mjs"));

const SNAP_DIR = path.join(HERE, "snapshots");
const UPDATE = process.argv.includes("--update");

let failures = 0;
let rendered = 0;

export function renderCase(name, draw) {
    const fb = harness.createFramebuffer();
    const ctx = harness.drawContext(fb);
    fb.clearScreen();
    draw(fb, ctx);
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
    if (UPDATE || !fs.existsSync(snapPath)) {
        fs.writeFileSync(snapPath, blocks);
    } else if (fs.readFileSync(snapPath, "utf8") !== blocks) {
        console.error("FAIL " + name + ": snapshot differs — rerun with --update if intended");
        failures++;
    }
    fs.writeFileSync(path.join(SNAP_DIR, name + ".png"), fb.toPng(4));
}

export async function main(cases) {
    for (const [name, draw] of cases) renderCase(name, draw);
    console.log("harness ok — " + rendered + " pages");
    if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
}

/* No cases yet — Task 6 supplies them. */
if (process.argv[1] && process.argv[1].endsWith("render.mjs")) await main([]);
