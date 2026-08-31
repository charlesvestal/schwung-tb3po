# TB-3PO Screen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TB-3PO's hand-rolled display with Schwung's shipping knob-grid chrome — two rings of six pages per slot, a step lane that follows you into the footer, and a to-scale pad map.

**Architecture:** `src/ui.js` keeps lifecycle, MIDI dispatch, the DSP bridge, LEDs and knob handling, and loses its entire draw layer. Drawing moves into four sibling `.mjs` modules that take an injected ctx and plain state, so every screen can be rendered and asserted on a Mac through `schwung/tools/param-pages/harness.mjs`. Page bodies are drawn by `renderPageMovy` / `drawKnobRow` from the host's shared library rather than reimplemented.

**Tech Stack:** QuickJS ES modules on device; Node 20+ with a `module.register()` resolve hook for host-side tests; the harness's 1-bit framebuffer for snapshots.

**User decisions (already made):**
- "A" — adopt the shipping page chrome (`renderPageMovy`), not a chrome-only pass.
- "two sets of pages, switchable by track buttons" — two rings of six, one per slot.
- "what if we put four knobs on page 1 with the sequencer?" — PERFORM is lane + a real knob row.
- Knobs 1–4 on PERFORM must **not** edit key/BPM/bank/direction ("i think not given the performance stuff we want").
- "box the whole set of values" — resolved by the knob row; the status panel is not built.
- "one pixel, but move it down two pixels. it's easier to spot as an H than an arc" — tie geometry.
- "setup being half empty is fine."
- Design doc approved as written: `docs/plans/2026-08-31-screen-redesign-design.md`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/params.mjs` | **New.** The `chain_params`-shaped param contract and the page ring definition. Pure data plus two small helpers. No drawing, no device globals. |
| `src/lane.mjs` | **New.** `drawBigLane` and `drawMiniLane`. Pure: takes a ctx, a step array, a position, a rect. |
| `src/pad_map.mjs` | **New.** `drawPadsPage` and `drawKeysPage`, plus the label-width guards. Pure. |
| `src/pages.mjs` | **New.** Composes a page: header, bank bar, body, footer. Owns the ring and the "303 page is absent" rule. Pure apart from the ctx it is handed. |
| `src/ui.js` | **Modified.** Lifecycle, MIDI dispatch, DSP bridge, LEDs, knob handling, ring state. Its draw layer is deleted. |
| `scripts/build.sh` | **Modified.** Copy the new `.mjs` files into `dist/tb3po/`. |
| `tests/hooks.mjs` | **New.** Resolve hook mapping `/data/UserData/schwung/` to the sibling repo. |
| `tests/render.mjs` | **New.** Renders every page, asserts zero clipped pixels and no missing glyphs, writes snapshots. |
| `tests/run.sh` | **New.** Entry point. |
| `src/help.json` | **Modified.** Retained for the Tools viewer; text updated for the new pages. |

Precedent for sibling `.mjs` imports from a tool's `ui.js`: `schwung-m8/src/ui.js` imports `./virtual_knobs.mjs` and ships it the same way.

---

### Task 1: Host-side render harness

**Goal:** A test rig that can import TB-3PO's drawing modules on a Mac and assert what they put on a 128×64 framebuffer.

**Files:**
- Create: `tests/hooks.mjs`
- Create: `tests/render.mjs`
- Create: `tests/run.sh`
- Create: `tests/snapshots/.gitkeep`

**Acceptance Criteria:**
- [ ] `bash tests/run.sh` exits 0 with no drawing modules yet present, reporting "0 pages"
- [ ] The hook resolves `/data/UserData/schwung/shared/param_pages/render_page_movy.mjs` to the sibling repo
- [ ] The run fails loudly, not silently, when the sibling `schwung` repo is absent

**Verify:** `bash tests/run.sh` → `harness ok — 0 pages` and exit 0

**Steps:**

- [ ] **Step 1: Write the resolve hook**

Create `tests/hooks.mjs`:

```js
/*
 * TB-3PO's modules import the shared library by its DEVICE path. On a Mac
 * those paths do not exist, so this hook rewrites them onto the sibling
 * schwung checkout. Keeping the device path in the source is deliberate: the
 * shipped file must be byte-identical to the tested one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEVICE = "/data/UserData/schwung/";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHWUNG_SRC = path.resolve(HERE, "../../schwung/src");

if (!fs.existsSync(SCHWUNG_SRC)) {
    throw new Error(
        "tests need the sibling schwung checkout at " + SCHWUNG_SRC +
        " — clone charlesvestal/schwung next to this repo");
}

export function resolve(specifier, context, next) {
    if (specifier.startsWith(DEVICE)) {
        const rel = specifier.slice(DEVICE.length);
        return { url: pathToFileURL(path.join(SCHWUNG_SRC, rel)).href, shortCircuit: true };
    }
    return next(specifier, context);
}
```

- [ ] **Step 2: Write the render runner**

Create `tests/render.mjs`:

```js
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
```

- [ ] **Step 3: Write the entry point**

Create `tests/run.sh`:

```bash
#!/usr/bin/env bash
# Host-side render tests. Needs the sibling schwung checkout and Node 20+.
set -euo pipefail
cd "$(dirname "$0")/.."
node tests/render.mjs "$@"
```

- [ ] **Step 4: Create the snapshot directory and run**

```bash
mkdir -p tests/snapshots && touch tests/snapshots/.gitkeep
chmod +x tests/run.sh
bash tests/run.sh
```

Expected: `harness ok — 0 pages`, exit 0.

- [ ] **Step 5: Prove the guard can fail**

Temporarily rename the sibling repo path in `tests/hooks.mjs` to `../../schwung-nope`, run `bash tests/run.sh`, and confirm it throws the "clone charlesvestal/schwung" error rather than passing. Restore the path.

This step exists because a probe that cannot fail reports green forever.

- [ ] **Step 6: Commit**

```bash
git add tests/
git commit -m "test: host-side render harness for TB-3PO pages"
```

---

### Task 2: Param contract and page ring

**Goal:** The `chain_params`-shaped declaration the grid reads its widgets from, and the ring definition that says which pages exist.

**Files:**
- Create: `src/params.mjs`
- Test: `tests/params.mjs`

**Acceptance Criteria:**
- [ ] `buildMetaIndex({ chainParams: TB3PO_PARAMS })` returns `kind: "number"` for `density` and `kind: "enum"` for `scale`
- [ ] `ringFor({ has303: true })` returns 6 pages; `ringFor({ has303: false })` returns 5 and contains no page named `303`
- [ ] Pattern row 0 is exactly `["density", "accent", "slide", "gate"]` — the four PERFORM inherits
- [ ] Every key named in a page exists in `TB3PO_PARAMS`

**Verify:** `node tests/params.mjs` → `params ok` and exit 0

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `tests/params.mjs`:

```js
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

import { TB3PO_PARAMS, PAGE_PATTERN, ringFor } from "../src/params.mjs";
/* Dynamic, not static: see the note in Task 4. params.mjs itself is pure data
 * with no device imports, so it may stay static. */
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/params.mjs`
Expected: FAIL — `Cannot find module .../src/params.mjs`

- [ ] **Step 3: Write the contract**

Create `src/params.mjs`:

```js
/*
 * TB-3PO's own param contract.
 *
 * TB-3PO is a tool, not a chain component, so nothing hands it a
 * `chain_params` declaration — it declares one for itself and builds a meta
 * index from it. That is the entire adaptation needed to use the shared knob
 * grid: `buildMetaIndex({ chainParams })` is happy with a plain array, and
 * every widget, label abbreviation and enum square follows from the declared
 * type.
 *
 * A key a page names but this array does not declare falls through to
 * getOrGuess, which invents a float 0..1 knob — that is how a module ends up
 * writing 0.058750 into an enum. tests/params.mjs asserts the two stay in
 * sync.
 */

export const ROOT_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const SCALE_NAMES = ["Minor", "Phrygian", "HarmMinor", "MinPent", "Dorian", "Major"];
export const LENGTHS = [8, 16, 24, 32];
export const DIRECTIONS = ["Fwd", "Rev", "Ping", "Rnd"];

export const TB3PO_PARAMS = [
    { key: "density", label: "Density", short_name: "Dens",  type: "float", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "accent",  label: "Accent",  short_name: "Acc",   type: "float", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "slide",   label: "Slide",   short_name: "Slide", type: "float", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "gate",    label: "Gate",    short_name: "Gate",  type: "float", min: 0.1, max: 1, step: 0.01, unit: "%" },
    { key: "root",    label: "Root",    short_name: "Root",  type: "enum",  options: ROOT_NAMES },
    { key: "scale",   label: "Scale",   short_name: "Scale", type: "enum",  options: SCALE_NAMES },
    { key: "length",  label: "Length",  short_name: "Len",   type: "enum",  options: LENGTHS.map(String) },
    { key: "octaves", label: "Octaves", short_name: "Oct",   type: "int",   min: 1, max: 3, step: 1 },

    /*
     * The 303 page's keys are the 303 PLUGIN's real param names, prefixed.
     *
     * Two reasons the prefix is not decoration. "accent" is already declared
     * above as this sequencer's accent PROBABILITY, and the 303's accent
     * AMOUNT is a different quantity on a different chain slot -- a shared
     * key string would collide in the meta index and in the values object.
     * And a declared key that matches no real param is a knob that turns and
     * changes nothing, so the suffix here is exactly CC_303_PARAM_KEYS from
     * ui.js and Task 7 strips "303." to get the write target.
     *
     * The prefix idiom is TB-3PO's own: per-slot DSP params are already
     * namespaced "a." / "b." for the same reason.
     */
    { key: "303.cutoff",    label: "Cutoff",    short_name: "Cut", type: "int", min: 0, max: 127, step: 1 },
    { key: "303.resonance", label: "Resonance", short_name: "Res", type: "int", min: 0, max: 127, step: 1 },
    { key: "303.decay",     label: "Decay",     short_name: "Dec", type: "int", min: 0, max: 127, step: 1 },
    { key: "303.env_mod",   label: "Env Mod",   short_name: "Env", type: "int", min: 0, max: 127, step: 1 },
    { key: "303.accent",    label: "Accent",    short_name: "Acc", type: "int", min: 0, max: 127, step: 1 },
    { key: "303.volume",    label: "Volume",    short_name: "Vol", type: "int", min: 0, max: 127, step: 1 },
    { key: "303.drive",     label: "Drive",     short_name: "Drv", type: "int", min: 0, max: 127, step: 1 },
    { key: "303.drive_mix", label: "Drive Mix", short_name: "Mix", type: "int", min: 0, max: 127, step: 1 },

    { key: "channel",   label: "MIDI Ch",   short_name: "Chan", type: "int",  min: 1, max: 16, step: 1 },
    { key: "direction", label: "Direction", short_name: "Dir",  type: "enum", options: DIRECTIONS },
    { key: "transpose", label: "Transpose", short_name: "Oct+", type: "int",  min: -48, max: 48, step: 12 },
    /*
     * A READOUT, not a control: `access: "read"`.
     *
     * The DSP exposes store_bank, recall_bank, recall_bank_now, bank_filled
     * and a read-only current_bank -- there is no plain bank SETTER, so a
     * normal declaration here would be a dial that turns and changes nothing.
     * `access: "read"` is the supported way to say that, and the shared UI
     * already honours it: a turn SHOWS the reading and writes nothing
     * (shadow_ui.js isReadoutParam), and a click does not open a picker.
     * keydetect is the canonical case.
     *
     * The key is `current_bank`, which is what the DSP actually answers to --
     * `bank` matches nothing.
     */
    { key: "current_bank", label: "Bank", short_name: "Bank", type: "int",
      min: 1, max: 8, step: 1, access: "read" },
];

export const PAGE_PERFORM = { name: "Steps", kind: "perform" };
/*
 * Row 0 is FEEL and row 1 is NOTES, and row 0 is exactly what PERFORM draws
 * under its lane in the same four positions. A knob that means Octaves on one
 * page and Gate on another is the defect this redesign exists to remove, so
 * these four and their order are load-bearing — see tests/params.mjs.
 */
export const PAGE_PATTERN = { name: "Pattern", kind: "knobs",
    keys: ["density", "accent", "slide", "gate", "root", "scale", "length", "octaves"] };
export const PAGE_303 = { name: "303", kind: "knobs",
    keys: ["303.cutoff", "303.resonance", "303.decay", "303.env_mod",
           "303.accent", "303.volume", "303.drive", "303.drive_mix"] };
/* Four knobs, four empty. Leaving it half-empty is a decision, not an
 * oversight: the alternative is moving a param off Pattern to fill space. */
export const PAGE_SETUP = { name: "Setup", kind: "knobs",
    keys: ["channel", "direction", "transpose", "current_bank",
           null, null, null, null] };
export const PAGE_PADS = { name: "Pads", kind: "pads" };
export const PAGE_KEYS = { name: "Keys", kind: "keys" };

/**
 * The pages this slot currently has.
 *
 * The 303 page is ABSENT rather than disabled when no 303 plugin is
 * reachable. Today that case is a refusal with an overlay explaining it; a
 * ring has nothing to refuse — the bank bar draws five segments and the
 * buttons that would have gone there land on Pattern.
 */
export function ringFor({ has303 }) {
    const pages = [PAGE_PERFORM, PAGE_PATTERN];
    if (has303) pages.push(PAGE_303);
    pages.push(PAGE_SETUP, PAGE_PADS, PAGE_KEYS);
    return pages;
}
```

- [ ] **Step 4: Run the test**

Run: `node tests/params.mjs`
Expected: `params ok`, exit 0

- [ ] **Step 5: Commit**

```bash
git add src/params.mjs tests/params.mjs
git commit -m "feat: TB-3PO declares its own param contract and page ring"
```

---

### Task 3: The step lane

**Goal:** `drawBigLane` and `drawMiniLane`, including tie geometry, as pure functions.

**Files:**
- Create: `src/lane.mjs`
- Test: `tests/lane.mjs`

**Acceptance Criteria:**
- [ ] A tie's connector pixel sits at a row where BOTH bars have pixels — asserted for accent→note, note→accent and note→note
- [ ] The connector is two rows below the deeper of the two heads
- [ ] The playhead column is full height in the mini lane and does not occupy the tie row
- [ ] Neither lane draws outside the rect it is given

**Verify:** `node tests/lane.mjs` → `lane ok` and exit 0

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `tests/lane.mjs`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/lane.mjs`
Expected: FAIL — `Cannot find module .../src/lane.mjs`

- [ ] **Step 3: Write the lane**

Create `src/lane.mjs`:

```js
/*
 * The step lane, at two densities.
 *
 * PERFORM gets the big one; every other page gets the compressed one in the
 * footer band. They are deliberately the same drawing rather than two
 * designs — same information, two zoom levels — so a mark must not change
 * MEANING between them, only size.
 */

export const REST = 0, NOTE = 1, ACCENT = 2, SLIDE = 3;

/*
 * Both lanes draw a 16-step WINDOW, because a pattern is 8, 16, 24 or 32 steps
 * and the screen is 128px wide.
 *
 * The two lanes pick their window differently, and the asymmetry is the point:
 *
 *   The BIG lane is something you EDIT. The pads write into the window on
 *   screen, so it must be the window the user chose with the < > buttons --
 *   auto-scrolling it would move the target out from under their hands.
 *
 *   The MINI lane is something you WATCH. It is ambient, has no interaction,
 *   and no room to say which window it is showing, so it always follows the
 *   playhead.
 *
 * An earlier draft of this file hard-coded steps 0..15 in both, which silently
 * dropped the back half of every 24- and 32-step pattern and lost the playhead
 * entirely once it passed step 15 -- while the Keys page still advertised
 * "< >  STEP PG".
 */
export function windowFor(position) { return Math.floor((position | 0) / 16) * 16; }

/* A slide is a note that ties into the next step, so it stands as tall as a
 * plain note. */
function isRest(s) { return s === REST; }
function isAccent(s) { return s === ACCENT; }

/**
 * The top row of one step's bar. A rest has only its floor pixel, so that row
 * is its "top" for tie purposes.
 */
function miniTop(y, h, s) {
    if (isRest(s)) return y + h - 1;
    return y + h - (isAccent(s) ? h : Math.max(2, h - 3));
}

/**
 * The 16-step lane compressed into a footer band.
 *
 * @param {object} state { steps: number[], position: number, heightOf?: fn }
 * @param {object} rect  { x, y, w, h }
 */
export function drawMiniLane(fb, ctx, state, rect) {
    const { x, y, w, h } = rect;
    const base = state.stepBase | 0;
    /* `?? REST` rather than a bare index: a window running past the end of a
     * short pattern must read as empty, and an undefined entry falls through
     * both isRest and isAccent into the note branch, i.e. it would draw as a
     * lit bar. */
    const at = (i) => state.steps[base + i] ?? REST;
    const steps = { length: 16 };
    const cw = w / 16;
    /* `heightOf` lets a test pin a slide's height without inventing a fifth
     * step state; in production a slide is always note-height. */
    const heightState = (i) =>
        state.heightOf ? state.heightOf(i) : (at(i) === SLIDE ? NOTE : at(i));

    for (let i = 0; i < 16; i++) {
        const cx = Math.round(x + i * cw), nx = Math.round(x + (i + 1) * cw);
        const bw = Math.max(1, nx - cx - 1);
        const s = at(i);

        if (base + i === state.position) {
            /* Full height, because the playhead is the one mark that has to
             * survive the compression whatever the step under it is. */
            ctx.fillRect(cx, y, bw, h, 1);
        } else if (isRest(s)) {
            ctx.fillRect(cx, y + h - 1, bw, 1, 1);
        } else {
            const top = miniTop(y, h, heightState(i));
            ctx.fillRect(cx, top, bw, y + h - top, 1);
        }

        if (s === SLIDE && i < 15) {
            /*
             * One pixel in the 1px gap the bars leave, TWO ROWS BELOW the
             * heads. At the head the pair reads as an arch, which at this size
             * is a smudge across three columns; dropped, it makes an H, and an
             * H is a shape the eye finds without looking for it.
             *
             * Measured from the DEEPER of the two heads: the crossbar has to
             * sit where both uprights exist, or an accent tied to a plain note
             * leaves the pixel floating above the second bar.
             */
            const deeper = Math.max(miniTop(y, h, heightState(i)),
                                    miniTop(y, h, heightState(i + 1)));
            ctx.fillRect(nx - 1, Math.min(deeper + 2, y + h - 1), 1, 1, 1);
        }
    }
}

/**
 * The full-size lane. Baseline across the rect, 8px per step.
 *
 * @param {object} rect { x, y, w, h } — h must be at least 22.
 */
export function drawBigLane(fb, ctx, state, rect) {
    const stepBase = state.stepBase | 0;
    const at = (i) => state.steps[stepBase + i] ?? REST;
    const base = rect.y + rect.h - 6;
    ctx.fillRect(rect.x, base, rect.w, 1, 1);

    for (let i = 0; i < 16; i++) {
        const x = rect.x + i * 8, s = at(i);
        if (isRest(s)) continue;
        const bh = isAccent(s) ? 13 : 8;
        ctx.fillRect(x + 2, base - bh, 5, bh, 1);
        /* The same tie, at the size where it can be a full bridge rather than
         * a single pixel. */
        if (s === SLIDE && i < 15) ctx.fillRect(x + 2, base - bh, 7, 1, 1);
    }
    for (let i = 0; i <= 16; i += 4) {
        ctx.fillRect(Math.min(rect.x + i * 8, rect.x + rect.w - 1), base + 1, 1, 3, 1);
    }
    /* Only when the playhead is inside the window being shown. */
    const pcol = (state.position | 0) - stepBase;
    if (pcol >= 0 && pcol < 16) ctx.fillRect(rect.x + pcol * 8 + 1, base + 2, 7, 2, 1);
}
```

- [ ] **Step 4: Run the test**

Run: `node tests/lane.mjs`
Expected: `lane ok`, exit 0

- [ ] **Step 5: Prove the tie assertion can fail**

Change `deeper + 2` to `miniTop(y, h, heightState(i)) + 2` (the wrong version — measuring from the slide's own head), rerun, and confirm `accent->note: connector not touching the second bar` fires. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/lane.mjs tests/lane.mjs
git commit -m "feat: step lane at two densities, with tie geometry"
```

---

### Task 4: Pads and Keys pages

**Goal:** The to-scale pad map with its live Shift variant, and the hardware-key reference, both with build-time width guards.

**Files:**
- Create: `src/pad_map.mjs`
- Test: `tests/pad_map.mjs`

**Acceptance Criteria:**
- [ ] Every action-pad label fits `CELL_W - 2` = 14px, asserted by measuring, not by eye
- [ ] No two Keys columns overlap, asserted by measuring
- [ ] `drawPadsPage(..., { shiftHeld: true })` differs from `shiftHeld: false`
- [ ] Neither page draws off-screen

**Verify:** `node tests/pad_map.mjs` → `pad map ok` and exit 0

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `tests/pad_map.mjs`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/pad_map.mjs`
Expected: FAIL — `Cannot find module .../src/pad_map.mjs`

- [ ] **Step 3: Write the pages**

Create `src/pad_map.mjs`:

```js
/*
 * The Pads and Keys pages.
 *
 * The pad map is a picture of the surface at its own proportions — four rows
 * of eight, drawn where the hands are — replacing a text HELP page that
 * clipped 21px off the right edge and repeated help.json.
 */
import { fontPrint4x5, fontWidth4x5 }
    from "/data/UserData/schwung/shared/param_pages/font4x5.mjs";

export const MAP_TOP = 13;
export const CELL_W = 16;
/*
 * The action row is TALLER than the three band rows. A band row needs one
 * clear row around a single label; the action row needs its labels clear of
 * the cell frames too. At a uniform 10px the frames ran into the tops of the
 * glyphs.
 */
export const BAND_H = 9;
export const ACT_H = 13;
const ACT_Y = MAP_TOP + 3 * BAND_H;

/*
 * Pad 1 is GEN, not NEW.
 *
 * A cell is 16px and its divider owns one column, so a label has 14. "NEW"
 * measures 15; "GEN" measures 14. Nearly every three-letter word in this face
 * lands on 14 or 15, so this is the constraint rather than a preference —
 * tests/pad_map.mjs measures every one of these.
 */
export const ACTION_LABELS = ["GEN", "MUT", "DIR", "CH-", "CH+", "", "", ""];

const caps = (s) => String(s).toUpperCase();

function bandY(row) { return MAP_TOP + row * BAND_H; }

/** One row-wide label, knocked out of the grid it sits on. */
function band(ctx, row, text, inverted) {
    const y = bandY(row);
    const t = caps(text), tw = fontWidth4x5(t);
    const tx = Math.floor((128 - tw) / 2), ty = y + 2;
    if (inverted) ctx.fillRect(0, y + 1, 128, BAND_H - 2, 1);
    /* Without the knockout the cell dividers run straight through the glyphs. */
    ctx.fillRect(tx - 3, ty - 1, tw + 6, 7, inverted ? 1 : 0);
    fontPrint4x5(ctx, tx, ty, t, inverted ? 0 : 1);
}

/** One action pad's label, centred on the interior its divider leaves. */
function actionCell(ctx, col, text) {
    if (!text) return;
    const t = caps(text), tw = fontWidth4x5(t);
    /*
     * Centred on the 15px INTERIOR, not the 16px cell, and FLOORED from the
     * interior's left edge — the divider is the separator between two
     * adjacent labels, and two 14px labels with no rule between them read as
     * one word because the gap between letters is already 1px.
     */
    fontPrint4x5(ctx, col * CELL_W + 1 + Math.floor((CELL_W - 1 - tw) / 2), ACT_Y + 4, t, 1);
}

function grid(ctx) {
    for (let r = 0; r < 3; r++) {
        const y = bandY(r);
        ctx.fillRect(0, y, 128, 1, 1);
        for (let c = 0; c <= 8; c++) ctx.fillRect(Math.min(c * CELL_W, 127), y, 1, BAND_H, 1);
    }
    ctx.fillRect(0, ACT_Y, 128, 1, 1);
    ctx.fillRect(0, ACT_Y + ACT_H, 128, 1, 1);
    for (let c = 0; c <= 8; c++) ctx.fillRect(Math.min(c * CELL_W, 127), ACT_Y, 1, ACT_H + 1, 1);
}

/**
 * @param {object} o { shiftHeld: boolean }
 *
 * The map REDRAWS while Shift is held rather than being drawn once with the
 * Shift meanings printed somewhere: live state cannot drift from what the
 * pads actually do.
 */
export function drawPadsPage(fb, ctx, o) {
    grid(ctx);
    band(ctx, 0, "steps 1-8", false);
    band(ctx, 1, "steps 9-16", false);
    band(ctx, 2, o.shiftHeld ? "save to bank 1-8" : "banks 1-8", !!o.shiftHeld);
    ACTION_LABELS.forEach((t, i) => actionCell(ctx, i, t));
}

export const COL_X = [2, 66];
export const KEY_W = 26;
export const KEY_ROWS = [
    [["+ -", "octave"],   ["< >", "step pg"]],
    [["shf+x", "clear"],  ["undo", "last op"]],
    [["t1 t2", "slot a - 3po / 303"]],
    [["t3 t4", "slot b - 3po / 303"]],
    [["step", "pages"],   ["play", "start"]],
];

export function drawKeysPage(fb, ctx) {
    KEY_ROWS.forEach((row, i) => {
        const y = 15 + i * 9;
        row.forEach((pair, c) => {
            fontPrint4x5(ctx, COL_X[c], y, caps(pair[0]), 1);
            fontPrint4x5(ctx, COL_X[c] + KEY_W, y, caps(pair[1]), 1);
        });
    });
}
```

- [ ] **Step 4: Run the test**

Run: `node tests/pad_map.mjs`
Expected: `pad map ok`, exit 0

- [ ] **Step 5: Prove the label guard can fail**

Change `ACTION_LABELS[0]` from `"GEN"` to `"NEW"`, rerun, and confirm `pad label NEW is 15px, budget 14` fires. Restore to `"GEN"`.

- [ ] **Step 6: Commit**

```bash
git add src/pad_map.mjs tests/pad_map.mjs
git commit -m "feat: to-scale pad map and hardware key reference"
```

---

### Task 5: Page composition

**Goal:** One entry point that draws any page in the ring — header, bank bar, body, footer — including the footer lane.

**Files:**
- Create: `src/pages.mjs`
- Test: `tests/pages.mjs`

**Acceptance Criteria:**
- [ ] `drawPage` handles all five page kinds (`perform`, `knobs`, `pads`, `keys`) without falling through
- [ ] PERFORM draws its knob row from `PAGE_PATTERN.keys` slots 0–3, not from a copy
- [ ] Every non-PERFORM page draws the mini lane in the footer band
- [ ] The bank bar segment count equals the ring length

**Verify:** `node tests/pages.mjs` → `pages ok` and exit 0

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `tests/pages.mjs`:

```js
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
    position: 6, stepView: 0,
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/pages.mjs`
Expected: FAIL — `Cannot find module .../src/pages.mjs`

- [ ] **Step 3: Write the composer**

Create `src/pages.mjs`:

```js
/*
 * Page composition: header, bank bar, body, footer.
 *
 * Bodies come from the SHARED library rather than being reimplemented, which
 * is the whole point of the redesign — every widget, the label abbreviations,
 * the touch strip and the enum square arrive with it, and later work on them
 * lands here for free.
 */
import { renderPageMovy, drawKnobRow, drawHeader, drawBankBar, drawFooter }
    from "/data/UserData/schwung/shared/param_pages/render_page_movy.mjs";
import { buildMetaIndex }
    from "/data/UserData/schwung/shared/param_pages/param_meta.mjs";
import { createAnimState }
    from "/data/UserData/schwung/shared/param_pages/anim_state.mjs";
import { TB3PO_PARAMS, PAGE_PATTERN } from "./params.mjs";
import { drawBigLane, drawMiniLane, windowFor } from "./lane.mjs";
import { drawPadsPage, drawKeysPage } from "./pad_map.mjs";

export const META = buildMetaIndex({ chainParams: TB3PO_PARAMS });
const ANIM = createAnimState();

const FOOTER_BAND = { y: 57, h: 7 };

function common(view) {
    return {
        metaIndex: META, values: view.values, anim: ANIM, nowMs: Date.now(),
        touched: view.touched, touchedSlots: view.touched >= 0 ? [view.touched] : [],
        modulated: () => false,
    };
}

/**
 * @param {object} view
 *   slotLabel, bpm, ring, pageIndex, steps, position, values, touched,
 *   shiftHeld
 */
export function drawPage(fb, ctx, view) {
    const page = view.ring[view.pageIndex];

    if (page.kind === "knobs") {
        renderPageMovy(ctx, Object.assign(common(view), {
            page, title: view.slotLabel,
            pageIndex: view.pageIndex, pageCount: view.ring.length,
        }));
        drawFooterLane(fb, ctx, view);
        return;
    }

    /* PERFORM's page name names the window: "Steps 1-16", "Steps 17-32". */
    const pageName = page.kind === "perform"
        ? page.name + " " + (view.stepView * 16 + 1) + "-" + (view.stepView * 16 + 16)
        : page.name;
    drawHeader(ctx, view.slotLabel + " - " + (view.bpm | 0), pageName, false);
    drawBankBar(ctx, view.pageIndex, view.ring.length, null);

    if (page.kind === "perform") {
        /* The window the USER chose, because the pads edit what is shown. */
        drawBigLane(fb, ctx, { ...view, stepBase: view.stepView * 16 },
                    { x: 0, y: 12, w: 128, h: 22 });
        /*
         * A GENUINE grid row, from Pattern's own key list: drawKnobRow takes
         * its own rowY/lblY, so this is the same code Pattern runs rather than
         * an imitation of it. Holding a knob therefore gives the same
         * full-width touch strip, because it is the same row.
         *
         * Knobs 5-8 do nothing here, and only one row is drawn — the page
         * shows exactly what its knobs do, which is the defect this redesign
         * exists to remove.
         */
        drawKnobRow(ctx, Object.assign(common(view), {
            page: { name: page.name, keys: PAGE_PATTERN.keys.slice(0, 4) },
        }), 0, 33, 48);
        drawFooter(ctx, [["PAD", "STEP"], ["BACK", "SUSPEND"]]);
        return;
    }

    if (page.kind === "pads") {
        drawPadsPage(fb, ctx, view);
        drawFooter(ctx, view.shiftHeld ? [["SHIFT", "HELD"], ["X", "CLEAR"]]
                                       : [["TAP", "REST>NOTE>ACC>SLIDE"]]);
        return;
    }

    if (page.kind === "keys") {
        drawKeysPage(fb, ctx);
        drawFooter(ctx, [["BACK", "SUSPEND"]]);
        return;
    }

    throw new Error("drawPage: unknown page kind " + page.kind);
}

/**
 * The lane in the footer band.
 *
 * This is the only spare real estate on the screen: the bank bar is 2px at
 * y=7 and the grid rows start at y=9, so there is nothing between them. The
 * footer is seven pixels currently spent on hints that stop being read.
 */
function drawFooterLane(fb, ctx, view) {
    drawFooter(ctx, [["JOG", "PAGE"]]);
    ctx.fillRect(46, 56, 82, 8, 0);
    /* The window the MUSIC is in, because nothing here is editable and there
     * is no room to say which window you are looking at. */
    drawMiniLane(fb, ctx, { ...view, stepBase: windowFor(view.position) },
                 { x: 48, y: FOOTER_BAND.y, w: 80, h: FOOTER_BAND.h });
}
```

- [ ] **Step 4: Run the test**

Run: `node tests/pages.mjs`
Expected: `pages ok`, exit 0

- [ ] **Step 5: Commit**

```bash
git add src/pages.mjs tests/pages.mjs
git commit -m "feat: page composition over the shared knob-grid chrome"
```

---

### Task 6: Wire the renders into the harness

**Goal:** Every page rendered and snapshotted by `tests/run.sh`, so a layout change is a diff rather than a report from hardware.

**Files:**
- Modify: `tests/render.mjs`
- Create: `tests/snapshots/*.txt` (generated)

**Acceptance Criteria:**
- [ ] `bash tests/run.sh` renders at least 8 cases (six pages, the Shift variant, a touched knob)
- [ ] All report zero clipped pixels and no missing glyphs
- [ ] A second run with no changes passes against the stored snapshots

**Verify:** `bash tests/run.sh` → `harness ok — 8 pages` and exit 0

**Steps:**

- [ ] **Step 1: Replace the empty case list**

In `tests/render.mjs`, replace the final block:

```js
/* No cases yet — Task 6 supplies them. */
if (process.argv[1] && process.argv[1].endsWith("render.mjs")) await main([]);
```

with:

```js
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
              channel: 1, direction: 0, transpose: 0, current_bank: 3 },
};

const ring = ringFor({ has303: true });
const cases = ring.map((page, i) =>
    [page.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
     (fb, ctx) => drawPage(fb, ctx, { ...VIEW, ring, pageIndex: i })]);

/* The two states a static render of the ring cannot reach. */
cases.push(["pads-shift", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW, ring, pageIndex: 4, shiftHeld: true })]);
cases.push(["pattern-touched", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW, ring, pageIndex: 1, touched: 1 })]);
/* And the ring one page short, which is what no 303 loaded looks like. */
const short = ringFor({ has303: false });
cases.push(["no-303-ring", (fb, ctx) =>
    drawPage(fb, ctx, { ...VIEW, ring: short, pageIndex: 0 })]);

await main(cases);
```

- [ ] **Step 2: Generate the snapshots**

```bash
bash tests/run.sh --update
```

Expected: `harness ok — 9 pages`, exit 0.

- [ ] **Step 3: Look at every PNG**

Open `tests/snapshots/*.png` and confirm each page is what the design describes. A snapshot test pins what you accepted — if you accept a wrong picture, it pins that.

- [ ] **Step 4: Run again clean**

```bash
bash tests/run.sh
```

Expected: `harness ok — 9 pages`, exit 0, no snapshot diffs.

- [ ] **Step 5: Commit**

```bash
git add tests/render.mjs tests/snapshots/
git commit -m "test: snapshot every TB-3PO page"
```

---

### Task 7: Rewrite ui.js onto the new drawing

**Goal:** `ui.js` uses the ring, the new draw layer and knob-driven editing; its hand-rolled draw layer and jog-menu machinery are gone.

**Files:**
- Modify: `src/ui.js` — delete lines 819–987 (the `// -------- Display ----------` block through `draw()`), delete `349–603` (jog-menu items and handlers), rewrite `handleKnob`/`knobOverlayInfo`, add ring state
- Modify: `src/params.mjs` — no change, imported

**Acceptance Criteria:**
- [ ] `node --check src/ui.js` passes and no reference to `drawMenuList`, `menuState`, `MODE_303`, `PAGE_MUTATION` or `drawBar` remains
- [ ] Jog turn changes `pageIndex`; jog click no longer enters an edit mode
- [ ] Step buttons 1–6 jump to a page; T1–T4 set slot and page
- [ ] Knob N edits the key at `ring[pageIndex].keys[N]` on a knobs page, and `PAGE_PATTERN.keys[N]` for N<4 on PERFORM
- [ ] Knobs 4–7 do nothing on PERFORM

**Verify:** `node --check src/ui.js && bash tests/run.sh` → both exit 0

**Steps:**

- [ ] **Step 1: Add the imports and ring state**

At the top of `src/ui.js`, alongside the existing imports:

```js
import { drawPage, META } from "./pages.mjs";
import { isReadOnly } from "/data/UserData/schwung/shared/param_pages/param_meta.mjs";
import { ringFor, PAGE_PATTERN, ROOT_NAMES, SCALE_NAMES, LENGTHS, DIRECTIONS }
    from "./params.mjs";
```

Replace the `currentPage` declaration with:

```js
/* One ring per slot: the track buttons switch rings, and jog never crosses
 * the A/B boundary. That is what keeps a six-segment bank bar readable as a
 * map of this slot rather than as a scrollbar over both. */
let pageIndex = [0, 0];
function ring() { return ringFor({ has303: has303Slot }); }
function curPage() { return ring()[pageIndex[ui.activeSlot]]; }
```

- [ ] **Step 2: Delete the draw layer**

Delete from `// -------- Display ----------` through the end of `function draw()`, and replace with:

```js
// -------- Display ----------

function draw() {
    if (typeof clear_screen !== "function") return;
    clear_screen();
    const fb = { fillRect: fill_rect };
    const ctx = { fillRect: fill_rect, print, textWidth: text_width, line: draw_line };
    const slot = cur();
    const r = ring();
    const idx = Math.min(pageIndex[ui.activeSlot], r.length - 1);
    drawPage(fb, ctx, {
        slotLabel: "Slot " + (ui.activeSlot === 0 ? "A" : "B"),
        bpm: ui.bpm, ring: r, pageIndex: idx,
        steps: slot.steps, position: slot.position,
        shiftHeld, touched: touchedKnob,
        values: dspValues(slot),
    });
    drawOverlay();
}

/* The grid reads values by KEY, so the slot's fields are projected onto the
 * declared keys rather than the grid being taught about slots. */
function dspValues(slot) {
    return {
        density: slot.density, accent: slot.accent, slide: slot.slide, gate: slot.gate,
        root: slot.root, scale: slot.scale,
        length: Math.max(0, LENGTHS.indexOf(slot.length)), octaves: slot.octaves,
        "303.cutoff": slot.cc303[0], "303.resonance": slot.cc303[1],
        "303.decay": slot.cc303[2], "303.env_mod": slot.cc303[3],
        "303.accent": slot.cc303[4], "303.volume": slot.cc303[5],
        "303.drive": slot.cc303[6], "303.drive_mix": slot.cc303[7],
        channel: slot.channel, direction: slot.direction, transpose: slot.transpose,
        current_bank: slot.currentBank + 1,
    };
}
```

- [ ] **Step 3: Delete the jog-menu machinery**

Delete `scalePageItems`, `mutationPageItems`, `channelPageItems`, `currentPageItems`, `adjustMenuItem`, `handleJogTurn`, `handleJogClick`, and the `menuState` field in `makeSlot`. Replace the jog handlers with:

```js
/* Jog turns PAGES. Editing a list with the jog is retired — every value is
 * edited by the knob above it, which is what the grid is for. */
function handleJogTurn(delta) {
    if (delta === 0) return;
    const n = ring().length;
    const step = delta > 0 ? 1 : -1;
    pageIndex[ui.activeSlot] = (pageIndex[ui.activeSlot] + step + n) % n;
    showOverlay("Page", curPage().name);
}
```

Remove the jog-click branch entirely from `onMidiMessageInternal` (CC 3), leaving jog click to the host's exit combo.

- [ ] **Step 4: Rewrite knob dispatch**

Replace `handleKnob` and `knobOverlayInfo`:

```js
/* Which key each physical knob edits on the page currently shown. PERFORM
 * inherits Pattern's ROW 0 -- the same four in the same positions, or knob 4
 * would mean Octaves on one page and Gate on another. Knobs 4-7 are inert
 * there, and only one row is drawn, so the page shows what its knobs do. */
function keyForKnob(idx) {
    const page = curPage();
    if (page.kind === "perform") return idx < 4 ? PAGE_PATTERN.keys[idx] : null;
    if (page.kind === "knobs") return page.keys[idx] || null;
    return null;
}

const STALE_KEYS = new Set(["density", "accent", "slide", "octaves"]);

function handleKnob(knobIdx, delta) {
    if (delta === 0) return;
    const key = keyForKnob(knobIdx);
    if (!key) return;
    /*
     * A READOUT shows its reading and writes nothing.
     *
     * The shadow UI does this for chain components in isReadoutParam, but
     * TB-3PO is a tool with its OWN knob dispatch, so it gets none of that for
     * free and has to honour `access: "read"` itself -- otherwise turning the
     * Bank cell would write current_bank, which the DSP does not accept.
     */
    if (isReadOnly(META.getOrGuess(key))) {
        const info = knobOverlayInfo(key);
        if (info) showOverlay(info.name, info.value);
        return;
    }
    if (curPage().name === "303") { send303Cc(knobIdx, delta); }
    else { editKey(key, delta); if (STALE_KEYS.has(key)) patternStale = true; }
    const info = knobOverlayInfo(key);
    if (info) showOverlay(info.name, info.value);
}
```

Add `editKey(key, delta)` routing to the existing `adjustFloat` / `adjustInt` / `adjustEnum` / `adjustLength` helpers by looking the key's meta up in `META`, and rewrite `knobOverlayInfo(key)` to take a key rather than an index.

- [ ] **Step 5: Track the touched knob**

In the knob-touch branch of `onMidiMessageInternal`, replace the overlay call with:

```js
/* The grid puts the held knob's full name and value in the header strip, so
 * the overlay is no longer needed for it -- but the strip needs to know which
 * knob is under a finger. */
let touchedKnob = -1;
```

set `touchedKnob = d1` on note-on for `d1 < 8` and `touchedKnob = -1` on note-off.

- [ ] **Step 6: Rewrite the button handlers**

Step buttons 1–6 set `pageIndex[ui.activeSlot] = n` (clamped to the ring length). T1–T4 become:

```js
/* Slot AND page, not slot and mode. 3PO vs 303 was a KNOB mode because there
 * was nowhere to show it; it is two pages now and the header names them. With
 * no 303 reachable the 303 page is absent from the ring, so T2/T4 land on
 * Pattern -- there is nothing to refuse and no overlay explaining a refusal. */
function selectSlotPage(slotIdx, pageName) {
    ui.activeSlot = slotIdx;
    setDspParam("active_slot", String(slotIdx));
    const r = ring();
    const found = r.findIndex((p) => p.name === pageName);
    pageIndex[slotIdx] = found >= 0 ? found : r.findIndex((p) => p.name === "Pattern");
    if (pageName === "303" && found >= 0) sync303FromPlugin();
}
```

with T1 → `(0, "Pattern")`, T2 → `(0, "303")`, T3 → `(1, "Pattern")`, T4 → `(1, "303")`.

- [ ] **Step 7: Check and test**

```bash
node --check src/ui.js
grep -nE "drawMenuList|menuState|MODE_303|PAGE_MUTATION|drawBar\(" src/ui.js
bash tests/run.sh
```

Expected: `--check` silent, grep finds nothing, harness passes.

`node --check` on a `.js` file silently accepts broken ES-module source, so the grep is not optional — it is what catches a half-finished delete.

- [ ] **Step 8: Commit**

```bash
git add src/ui.js
git commit -m "feat: TB-3PO drives the shared knob grid, retires the jog menus"
```

---

### Task 8: Ship the new files

**Goal:** The `.mjs` modules reach the device, and the module gates on a host that exports what it needs.

**Files:**
- Modify: `scripts/build.sh:49-51`
- Modify: `src/module.json`
- Modify: `src/help.json`

**Acceptance Criteria:**
- [ ] `dist/tb3po/` contains `ui.js`, `params.mjs`, `lane.mjs`, `pad_map.mjs`, `pages.mjs`, `dsp.so`, `module.json`, `help.json`
- [ ] The tarball contains the same, under a top-level `tb3po/`
- [ ] `module.json` declares a `min_host_version` covering the `drawFooter` change
- [ ] `help.json` describes the six pages, not the old five

**Verify:** `./scripts/build.sh && tar -tzf dist/tb3po-module.tar.gz` → lists all four `.mjs` files

**Steps:**

- [ ] **Step 1: Copy the new modules in build.sh**

Replace `cat src/ui.js > "$DIST_DIR/ui.js"` with:

```bash
# ui.js plus its sibling ES modules. A missed file here fails at IMPORT time
# on the device, i.e. a module that installs cleanly and then does not load —
# which is exactly how v0.2.7 happened.
for f in ui.js params.mjs lane.mjs pad_map.mjs pages.mjs; do
    cat "src/$f" > "$DIST_DIR/$f"
done
```

- [ ] **Step 2: Verify the packaging**

```bash
./scripts/build.sh
tar -tzf dist/tb3po-module.tar.gz
```

Expected: `tb3po/params.mjs`, `tb3po/lane.mjs`, `tb3po/pad_map.mjs`, `tb3po/pages.mjs` all listed.

- [ ] **Step 3: Bump the version and host floor**

In `src/module.json`, set `"version": "0.3.0"` and `"min_host_version"` to the Schwung release carrying the `drawFooter` left-hint change from Task 9. TB-3PO already has one release (v0.2.7) that exists solely because it imported a host export that had been removed — the floor is not paperwork.

- [ ] **Step 4: Update help.json**

Rewrite the page list for the six-page ring and remove references to knob modes and the HELP page. Keep it — the Tools help viewer reads it, and the on-screen Pads page is a picture rather than a replacement for prose.

- [ ] **Step 5: Commit**

```bash
git add scripts/build.sh src/module.json src/help.json
git commit -m "build: ship the sibling ES modules; v0.3.0"
```

---

### Task 9: The drawFooter left-hint change (schwung repo)

**Goal:** A footer hint can sit left when something else owns the right edge.

**Files:**
- Modify: `../schwung/src/shared/param_pages/render_page_movy.mjs` — `drawFooter`, around line 2571
- Test: `../schwung/tests/host/test_footer_hint_side.sh`

**Acceptance Criteria:**
- [ ] `drawFooter(ctx, hints, { backLeft: true })` places the back hint at the left edge
- [ ] Default behaviour is unchanged — every existing snapshot in the schwung suite still passes
- [ ] TB-3PO's footer lane no longer overlaps a pill

**Verify:** `cd ../schwung && make -C tests/host test && for t in tests/host/*.sh; do bash "$t"; done` → all green

**Steps:**

- [ ] **Step 1: Read the existing behaviour**

`drawFooter` finds a back hint with `isBackHint` and pins it right, flowing the others from the left. The change adds an option, it does not move the default.

- [ ] **Step 2: Add the option**

Change the signature to `drawFooter(ctx, hints, o = {})` and, where the back hint's x is computed, branch on `o.backLeft` to place it at the left edge with the remaining hints flowing after it.

- [ ] **Step 3: Write the pin test**

Create `../schwung/tests/host/test_footer_hint_side.sh`, rendering a footer both ways into the harness and asserting the back pill's leftmost lit column differs, and that the default matches the current snapshot.

Note: an apostrophe inside a single-quoted bash string breaks these test files — keep the node source apostrophe-free.

- [ ] **Step 4: Run the schwung suite**

```bash
cd ../schwung && make -C tests/host test && for t in tests/host/*.sh; do bash "$t"; done
```

Expected: all green. CI gates exactly this subset.

- [ ] **Step 5: Branch and PR**

`main` is branch-protected and direct pushes are blocked, so this goes on a branch with a PR and three green checks. Confirm the merge with `gh pr view <n> --json state,mergeCommit` rather than trusting `gh pr merge`'s exit status — it reports a failure it did not have when `main` is checked out in a worktree, and skips `--delete-branch`.

- [ ] **Step 6: Use it from TB-3PO**

In `src/pages.mjs`, change `drawFooterLane` to pass `{ backLeft: true }` and keep `["BACK", "SUSPEND"]` rather than `["JOG", "PAGE"]`, then re-run `bash tests/run.sh --update` and look at the PNGs.

---

### Task 10: Hardware verification

**Goal:** Confirm on a Move the three behaviours no host-side render can prove.

**Files:** none

**Acceptance Criteria:**
- [ ] Holding a knob on PERFORM puts that param's full name and value in the header strip
- [ ] The Pads page redraws while Shift is held and reverts on release
- [ ] With no 303 loaded the bank bar shows five segments, and T2 lands on Pattern with no overlay
- [ ] Jog crosses all six pages and does not cross into the other slot
- [ ] The footer lane advances with the sequencer on Pattern, 303, Setup, Pads and Keys

**Verify:** manual, on device

**Steps:**

- [ ] **Step 1: Build and install**

```bash
./scripts/build.sh && ./scripts/install.sh
```

External modules need no service restart. Ask before installing if the device is in use.

- [ ] **Step 2: Walk the ring**

Open Tools → TB-3PO. Jog through all six pages, confirming the bank bar's filled segment tracks and the header names the slot.

- [ ] **Step 3: Check the three renders cannot prove**

Hold each knob on PERFORM and on Pattern; hold Shift on Pads; unload the 303 and confirm the ring drops to five.

- [ ] **Step 4: Watch the footer lane**

Start the transport and confirm the playhead advances in the footer on every non-PERFORM page.

- [ ] **Step 5: Tag and release**

```bash
git tag v0.3.0 && git push --tags
```

Then update `release.json` and add release notes with `gh release edit`.

---

## Deferred decisions

**Screen-reader announcements for the Pads and Keys pages.** The design doc
lists this as its one open item. It is not a task above because the shape of
the answer depends on what `announce_page.mjs` already emits for a knob page,
which is worth reading before deciding — and because the redesign is testable
and shippable without it. Raise it after Task 7, when the ring exists and the
announcement points are visible.

---

## Self-review notes

- Spec coverage: findings 1–3 → Tasks 5, 7 and 1/6; page ring → Task 2; knob
  assignment → Tasks 2 and 7; navigation → Task 7; lane and ties → Task 3;
  Pads/Keys → Task 4; footer lane → Tasks 5 and 9; removals → Task 7;
  verification → Tasks 1, 6 and 10; the one open item is deferred above.
- Type consistency: `PAGE_PATTERN.keys` is the single source for PERFORM's
  row in both `pages.mjs` and `ui.js`; `drawMiniLane`/`drawBigLane` take the
  same `(fb, ctx, state, rect)` shape everywhere; `ringFor({ has303 })` is
  called with the same argument name in `ui.js` and both tests.
