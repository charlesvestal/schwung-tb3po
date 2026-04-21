// TB-3PO UI — pad/knob/display bridge. All sequencing lives in dsp.so.

import {
    showOverlay, tickOverlay, drawOverlay, hideOverlay
} from '/data/UserData/schwung/shared/menu_layout.mjs';

//
// Knobs (CC 71-78, relative encoders) edit params. Pads are arranged 4x8
// bottom-to-top: row 0 (notes 68-75) = actions, row 1 (76-83) = banks,
// row 2 (84-91) = steps 9-16, row 3 (92-99, top) = steps 1-8.
//
// Knob CCs arrive as accumulated synthetic messages from shadow_ui.js (see
// the overtake knob accumulator — positive count = CW, 128-value = CCW).

const SCALE_NAMES = ["Minor", "Phrygian", "HarmMinor", "MinPent", "Dorian", "Major"];
const ROOT_NAMES  = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const LENGTHS     = [8, 16, 24, 32];
const DIRECTIONS  = ["Fwd", "Rev", "Ping", "Rnd"];

const STEP_REST = 0;
const STEP_NOTE = 1;
const STEP_ACCENT = 2;
const STEP_SLIDE = 3;

const NOTE_PAD_BASE = 68;       // note 68 = pad 0 (bottom-left)
const NOTE_STEP_BASE = 16;      // notes 16..31 = step buttons 1..16
const NUM_STEP_BUTTONS = 16;
const CC_KNOB_BASE = 71;        // CCs 71..78 = knobs 1..8
const CC_SHIFT = 49;
const CC_BACK = 51;
const CC_DELETE = 119;          // Move's X / Delete button
const CC_DOWN = 54;             // Move's - button (octave down)
const CC_UP = 55;               // Move's + button (octave up)
const CC_LEFT = 62;             // Move's Left button (step page -)
const CC_RIGHT = 63;            // Move's Right button (step page +)
const CC_TRACK1 = 43;           // Track 1 button (reversed: CC43=T1, CC40=T4)
const CC_TRACK2 = 42;

// Control modes — determines what the 8 knobs do.
const MODE_3PO = 0;             // Sequencer params (density/accent/slide/...)
const MODE_303 = 1;             // Live CC send to the 303 synth
const MODE_NAMES = ["3PO", "303"];

// 303 CC map (matches schwung-303 plugin).
// Indexed by knob slot 0..7 → MIDI CC number.
const CC_303 = [74, 71, 75, 70, 16, 7, 12, 13];
const CC_303_LABELS = ["Cut", "Res", "Dec", "Env", "Acc", "Vol", "OvL", "OvW"];

const PAGE_PERFORM = 0;
const PAGE_MUTATION = 1;
const PAGE_SCALE = 2;
const PAGE_HELP = 3;
const NUM_PAGES = 4;
const PAGE_NAMES = ["PERFORM", "MUTATION", "SCALE", "HELP"];

// LED palette — values are Move's note velocities (see shared/constants.mjs).
const LED_OFF       = 0;
const LED_DARK_GREY = 124;
const LED_WHITE     = 120;
const LED_RED       = 1;
const LED_ORANGE    = 47;
const LED_YELLOW    = 50;
const LED_GREEN     = 8;
const LED_TEAL      = 87;
const LED_BLUE      = 95;
const LED_INDIGO    = 102;
const LED_PURPLE    = 107;
const LED_PINK      = 25;

// Local cached state (display only — DSP is source of truth).
let ui = {
    position: 0,
    length: 16,
    density: 0.7,
    accent: 0.4,
    slide: 0.25,
    octaves: 2,
    root: 9,
    scale: 0,
    bpm: 120,
    gate: 0.5,
    channel: 1,
    direction: 0,
    currentBank: 0,
    pendingRecall: -1,
    bankFilled: new Array(8).fill(false),
    transpose: 0,
    running: 1,
    steps: new Array(32).fill(STEP_REST)
};

let pollTick = 0;
let shiftHeld = false;
let currentPage = PAGE_PERFORM;
let controlMode = MODE_3PO;
let stepView = 0;   // which 16-step window of the pattern is shown (0 or 1)

function stepPageCount() { return Math.max(1, Math.ceil(ui.length / 16)); }
function clampStepView()  { const m = stepPageCount() - 1; if (stepView > m) stepView = m; if (stepView < 0) stepView = 0; }

// Running CC values for 303 mode — one per knob slot. Start at 64 (midpoint)
// so the first nudge lands in a sane place.
const cc303Values = new Array(8).fill(64);

// -------- DSP bridge ----------

function setDspParam(key, val) {
    if (typeof host_module_set_param === "function") {
        host_module_set_param(key, String(val));
    }
}

function getDspParam(key) {
    if (typeof host_module_get_param === "function") {
        return host_module_get_param(key);
    }
    return null;
}

function parsePattern(s) {
    if (!s) return;
    const parts = s.split("|");
    if (parts.length < 2) return;
    const len = parseInt(parts[0], 10);
    if (isFinite(len) && len > 0) ui.length = len;
    const stepsCsv = parts[1].split(",");
    for (let i = 0; i < stepsCsv.length && i < ui.steps.length; i++) {
        ui.steps[i] = parseInt(stepsCsv[i], 10) | 0;
    }
}

function pollDsp() {
    const pos = getDspParam("position");
    if (pos !== null && pos !== "") ui.position = parseInt(pos, 10) | 0;
    if ((pollTick % 10) === 0) {
        parsePattern(getDspParam("pattern"));
        const bank = getDspParam("current_bank");
        if (bank !== null && bank !== "") ui.currentBank = parseInt(bank, 10) | 0;
        const pending = getDspParam("pending_recall");
        if (pending !== null && pending !== "") ui.pendingRecall = parseInt(pending, 10) | 0;
        const running = getDspParam("running");
        if (running !== null && running !== "") ui.running = parseInt(running, 10) | 0;
    }
    if ((pollTick % 30) === 0) {
        const bf = getDspParam("bank_filled");
        if (bf && typeof bf === "string") {
            for (let i = 0; i < ui.bankFilled.length; i++) {
                ui.bankFilled[i] = (bf[i] === "1");
            }
        }
    }
    pollTick++;
}

// -------- Knob handling ----------

function decodeDelta(value) {
    // Shadow UI flushes relative encoders as: 1..63 = CW count, 65..127 = CCW (128 - v).
    if (value === 0 || value === 64) return 0;
    if (value <= 63) return value;
    return -(128 - value);
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function adjustFloat(key, uiKey, delta, step, lo, hi) {
    const next = clamp(ui[uiKey] + delta * step, lo, hi);
    if (next !== ui[uiKey]) {
        ui[uiKey] = next;
        setDspParam(key, next.toFixed(3));
    }
}

function adjustInt(key, uiKey, delta, lo, hi) {
    const next = clamp((ui[uiKey] | 0) + delta, lo, hi);
    if (next !== ui[uiKey]) {
        ui[uiKey] = next;
        setDspParam(key, String(next));
    }
}

function adjustEnum(key, uiKey, delta, count) {
    const next = ((ui[uiKey] | 0) + delta + count * 10) % count;  // +10*count guards against large negative deltas
    if (next !== ui[uiKey]) {
        ui[uiKey] = next;
        setDspParam(key, String(next));
    }
}

function adjustLength(delta) {
    const idx = LENGTHS.indexOf(ui.length);
    const next = LENGTHS[clamp((idx < 0 ? 1 : idx) + (delta > 0 ? 1 : -1), 0, LENGTHS.length - 1)];
    if (next !== ui.length) {
        ui.length = next;
        setDspParam("length", String(next));
    }
}

let patternStale = false;  // true when prob-knobs have changed since last generate

function knobOverlayInfo(idx) {
    if (controlMode === MODE_303) {
        const label = CC_303_LABELS[idx] || "?";
        return { name: "303 " + label, value: String(cc303Values[idx] | 0) };
    }
    switch (idx) {
        case 0: return { name: "Density", value: Math.round(ui.density * 100) + "%" };
        case 1: return { name: "Accent",  value: Math.round(ui.accent  * 100) + "%" };
        case 2: return { name: "Slide",   value: Math.round(ui.slide   * 100) + "%" };
        case 3: return { name: "Octaves", value: String(ui.octaves) };
        case 4: return { name: "Root",    value: ROOT_NAMES[ui.root] || "?" };
        case 5: return { name: "Scale",   value: SCALE_NAMES[ui.scale] || "?" };
        case 6: return { name: "Length",  value: ui.length + " steps" };
        case 7: return { name: "Gate",    value: Math.round(ui.gate * 100) + "%" };
    }
    return null;
}

function handleKnob(knobIdx, delta) {
    if (delta === 0) return;
    if (controlMode === MODE_303) {
        send303Cc(knobIdx, delta);
    } else {
        switch (knobIdx) {
            // Probability/shape knobs — affect the NEXT generation. Press the NEW
            // action pad (or Mutate) to apply. Mark the pattern as stale so the UI
            // can nudge the user.
            case 0: adjustFloat("density", "density", delta, 0.01, 0, 1); patternStale = true; break;
            case 1: adjustFloat("accent",  "accent",  delta, 0.01, 0, 1); patternStale = true; break;
            case 2: adjustFloat("slide",   "slide",   delta, 0.01, 0, 1); patternStale = true; break;
            case 3: adjustInt  ("octaves", "octaves", delta, 1, 3);       patternStale = true; break;
            // Playback knobs — affect emission immediately without regenerating.
            case 4: adjustEnum("root",     "root",    delta, 12); break;
            case 5: adjustEnum("scale",    "scale",   delta, SCALE_NAMES.length); break;
            case 6: adjustLength(delta); break;
            case 7: adjustFloat("gate",    "gate",    delta, 0.05, 0.1, 1.0); break;
        }
    }
    // Update overlay with fresh value.
    const info = knobOverlayInfo(knobIdx);
    if (info) showOverlay(info.name, info.value);
}

function send303Cc(knobIdx, delta) {
    const cc = CC_303[knobIdx];
    if (cc === undefined) return;
    const next = clamp((cc303Values[knobIdx] | 0) + delta, 0, 127);
    if (next === cc303Values[knobIdx]) return;
    cc303Values[knobIdx] = next;
    if (typeof shadow_send_midi_to_dsp === "function") {
        const chStatus = 0xB0 | ((ui.channel - 1) & 0x0F);
        shadow_send_midi_to_dsp([chStatus, cc, next]);
    }
}

// -------- Pad handling ----------

function cycleStepState(stepIdx) {
    if (stepIdx < 0 || stepIdx >= ui.length) return;
    const cur = ui.steps[stepIdx] | 0;
    const next = (cur + 1) & 3;  // rest → note → accent → slide → rest
    ui.steps[stepIdx] = next;
    setDspParam("set_step", stepIdx + ":" + next);
}

function handlePadNoteOn(note, vel) {
    if (vel === 0) return;  // release
    const padIdx = note - NOTE_PAD_BASE;
    if (padIdx < 0 || padIdx > 31) return;
    const row = Math.floor(padIdx / 8);  // 0 bottom, 3 top
    const col = padIdx % 8;

    if (row === 3) {                     // top row: first 8 steps of current page
        cycleStepState(stepView * 16 + col);
    } else if (row === 2) {              // next 8 steps of current page
        cycleStepState(stepView * 16 + 8 + col);
    } else if (row === 1) {              // banks (Shift = store, plain = recall-at-next-bar)
        const bn = col + 1;
        if (shiftHeld) {
            setDspParam("store_bank", String(col));
            ui.currentBank = col;
            showOverlay("Bank " + bn, "saved");
        } else {
            if (ui.running) {
                /* Queue the recall; DSP applies at next bar boundary. */
                setDspParam("recall_bank", String(col));
                ui.pendingRecall = col;
                showOverlay("Bank " + bn, "queued");
            } else {
                /* Transport stopped — no bar boundary coming, apply now. */
                setDspParam("recall_bank_now", String(col));
                ui.currentBank = col;
                ui.pendingRecall = -1;
                showOverlay("Bank " + bn, "recalled");
            }
        }
    } else {                             // row 0: actions
        switch (col) {
            case 0:
                setDspParam("generate", "0");
                patternStale = false;
                showOverlay("Pattern", "regenerated");
                break;
            case 1:
                setDspParam("mutate", "1");
                showOverlay("Pattern", "mutated");
                break;
            case 2:
                ui.direction = (ui.direction + 1) & 3;
                setDspParam("direction", String(ui.direction));
                showOverlay("Direction", DIRECTIONS[ui.direction] || "?");
                break;
            case 3:
                adjustInt("channel", "channel", -1, 1, 16);
                showOverlay("Channel", String(ui.channel));
                break;
            case 4:
                adjustInt("channel", "channel", +1, 1, 16);
                showOverlay("Channel", String(ui.channel));
                break;
            default: break;
        }
    }
}

// -------- LED feedback ----------
// We cache per-pad color locally so we only send move_midi_internal_send when
// the color actually changes. This avoids flooding the LED queue AND minimizes
// echo potential (each change potentially round-trips through Move firmware).

const ledCache = new Array(256).fill(-1);  // [0..127] = note LEDs, [128..255] = CC LEDs

function padNote(row, col) { return NOTE_PAD_BASE + row * 8 + col; }

function setLed(row, col, color) {
    if (typeof move_midi_internal_send !== "function") return;
    const note = padNote(row, col);
    const c = color & 0x7F;
    if (ledCache[note] === c) return;
    ledCache[note] = c;
    move_midi_internal_send([0x09, 0x90, note, c]);
}

function stepLedColor(kind) {
    switch (kind) {
        case STEP_NOTE:   return LED_WHITE;
        case STEP_ACCENT: return LED_RED;
        case STEP_SLIDE:  return LED_BLUE;
        default:          return LED_OFF;
    }
}

function setStepLed(idx, color) {
    if (typeof move_midi_internal_send !== "function") return;
    const note = NOTE_STEP_BASE + idx;
    const c = color & 0x7F;
    if (ledCache[note] === c) return;
    ledCache[note] = c;
    move_midi_internal_send([0x09, 0x90, note, c]);
}

// Track-row LEDs are set via CC (0xB0). The shim's LED queue dedupes on note
// and CC separately. Our ledCache uses the LED key-space: notes live at
// [0..127], so stash CC-addressed LEDs starting at 128 to avoid collision.
function setTrackLed(cc, color) {
    if (typeof move_midi_internal_send !== "function") return;
    const key = 128 + cc;
    const c = color & 0x7F;
    if (ledCache[key] === c) return;
    ledCache[key] = c;
    move_midi_internal_send([0x0B, 0xB0, cc, c]);
}

function refreshLeds() {
    clampStepView();
    const pageBase = stepView * 16;

    // Rows 2 & 3 — step grid for the current 16-step page. Cursor = bright
    // white on the playing step, but only when that step is visible on this
    // page (so the cursor disappears when playback moves off-page).
    for (let col = 0; col < 8; col++) {
        const step = pageBase + col;
        let color = (step < ui.length) ? stepLedColor(ui.steps[step]) : LED_OFF;
        if (ui.running && step === ui.position) color = LED_WHITE;
        setLed(3, col, color);
    }
    for (let col = 0; col < 8; col++) {
        const step = pageBase + 8 + col;
        let color = (step < ui.length) ? stepLedColor(ui.steps[step]) : LED_OFF;
        if (ui.running && step === ui.position) color = LED_WHITE;
        setLed(2, col, color);
    }

    // Row 1 — banks. Current = bright purple, filled = teal, empty = off.
    // Queued recall flashes between bright yellow and its normal colour.
    const flashPhase = Math.floor(pollTick / 4) & 1;
    for (let col = 0; col < 8; col++) {
        let color;
        if (col === ui.pendingRecall && flashPhase) {
            color = LED_YELLOW;
        } else if (col === ui.currentBank) {
            color = LED_PURPLE;
        } else if (ui.bankFilled[col]) {
            color = LED_TEAL;
        } else {
            color = LED_OFF;
        }
        setLed(1, col, color);
    }

    // Row 0 — actions. Octave ± and CLEAR live on the hardware +/− and X
    // buttons, so pads 6-8 are unused and dark.
    setLed(0, 0, LED_TEAL);       // NEW
    setLed(0, 1, LED_INDIGO);     // MUTATE
    setLed(0, 2, LED_ORANGE);     // DIR
    setLed(0, 3, LED_DARK_GREY);  // Ch-
    setLed(0, 4, LED_DARK_GREY);  // Ch+
    setLed(0, 5, LED_OFF);
    setLed(0, 6, LED_OFF);
    setLed(0, 7, LED_OFF);

    // Step buttons 1..NUM_PAGES — page selector. Current page bright, others dim.
    for (let i = 0; i < NUM_STEP_BUTTONS; i++) {
        if (i < NUM_PAGES) {
            setStepLed(i, (i === currentPage) ? LED_WHITE : LED_DARK_GREY);
        } else {
            setStepLed(i, LED_OFF);
        }
    }

    // Track buttons 1..2 — knob mode indicator.
    setTrackLed(CC_TRACK1, controlMode === MODE_3PO ? LED_TEAL   : LED_DARK_GREY);
    setTrackLed(CC_TRACK2, controlMode === MODE_303 ? LED_ORANGE : LED_DARK_GREY);
}

// -------- Display ----------

// Action pad labels — the 8 pads on the bottom row (row 0 of the pad grid).
// Several actions live on hardware buttons instead of pads so the grid stays
// clean: CLEAR on X, octave ± on the + / − buttons, transport on Play.
const PAD_ACTION_LABELS = ["NEW", "MUT", "DIR", "Ch-", "Ch+", "", "", ""];

function drawStepGrid(y) {
    if (typeof draw_rect !== "function" || typeof fill_rect !== "function") return;
    clampStepView();
    const pageBase = stepView * 16;
    const nVisible = Math.max(0, Math.min(16, ui.length - pageBase));
    for (let i = 0; i < nVisible; i++) {
        const x = i * 8;
        const step = pageBase + i;
        const s = ui.steps[step];
        const isNow = (step === ui.position);
        if (s === STEP_REST) {
            draw_rect(x + 2, y + 2, 4, 4, 1);
        } else if (s === STEP_NOTE) {
            fill_rect(x + 2, y + 1, 4, 6, 1);
        } else if (s === STEP_ACCENT) {
            fill_rect(x + 1, y, 6, 8, 1);
        } else if (s === STEP_SLIDE) {
            fill_rect(x + 2, y + 1, 4, 6, 1);
            if (typeof draw_line === "function") draw_line(x, y + 8, x + 8, y + 8, 1);
        }
        if (isNow) draw_rect(x, y - 1, 8, 10, 1);
    }
}

// Horizontal bar: empty frame + filled proportion. Label on left, value on right.
function drawBar(y, label, frac, valStr) {
    if (typeof print === "function") print(0, y, label, 1);
    const BAR_X = 32, BAR_W = 72, BAR_H = 6;
    if (typeof draw_rect === "function") draw_rect(BAR_X, y, BAR_W, BAR_H, 1);
    const fw = Math.max(0, Math.min(BAR_W - 2, Math.round((BAR_W - 2) * frac)));
    if (fw > 0 && typeof fill_rect === "function") fill_rect(BAR_X + 1, y + 1, fw, BAR_H - 2, 1);
    if (typeof print === "function") print(BAR_X + BAR_W + 2, y, valStr, 1);
}

function drawPageFooter(y) {
    if (typeof print !== "function") return;
    // "Page 1 PERFORM" — just name the current page and offer step hint.
    print(0, y, "Page " + (currentPage + 1) + " " + PAGE_NAMES[currentPage], 1);
}

function drawPerformPage() {
    const scaleName = (SCALE_NAMES[ui.scale] || "?").substr(0, 3);
    const rootName = ROOT_NAMES[ui.root] || "?";
    const dirName = DIRECTIONS[ui.direction] || "?";
    if (typeof print === "function") {
        // 21-char max: "Amin 120bpm Fwd Ch1 B2"
        print(0, 0, rootName + scaleName + " " + (ui.bpm | 0) + "bpm " +
                     dirName + " Ch" + ui.channel + " B" + (ui.currentBank + 1), 1);
    }
    drawStepGrid(12);
    if (typeof print === "function") {
        const modeTxt = "knobs: " + MODE_NAMES[controlMode];
        const pageTxt = stepPageCount() > 1 ? ("  pg" + (stepView + 1) + "/" + stepPageCount()) : "";
        print(0, 26, "Pos " + (ui.position + 1) + "/" + ui.length + pageTxt + "  " + modeTxt, 1);
        if (patternStale) {
            print(0, 40, "* press Pad 1 for NEW", 1);
        } else if (stepPageCount() > 1) {
            print(0, 40, "</> pages  T1=3PO T2=303", 1);
        } else {
            print(0, 40, "T1=3PO  T2=303", 1);
        }
    }
    drawPageFooter(56);
}

function drawMutationPage() {
    if (controlMode === MODE_303) {
        // 303 mode — show the 8 CC knobs as a compact two-column legend.
        if (typeof print !== "function") return;
        print(0, 0, "303 CC KNOBS", 1);
        for (let k = 0; k < 8; k++) {
            const row = k % 4;
            const leftCol = k < 4;
            const x = leftCol ? 0 : 66;
            const y = 14 + row * 10;
            print(x, y, (k + 1) + " " + CC_303_LABELS[k] + " " + cc303Values[k], 1);
        }
        print(0, 56, "T1=3PO  T2=303", 1);
        return;
    }
    if (typeof print === "function") {
        print(0, 0, "MUTATION" + (patternStale ? "  * stale" : ""), 1);
    }
    drawBar(12, "Dens", ui.density, Math.round(ui.density * 100) + "%");
    drawBar(22, "Accn", ui.accent,  Math.round(ui.accent * 100) + "%");
    drawBar(32, "Slid", ui.slide,   Math.round(ui.slide * 100) + "%");
    drawBar(42, "Oct",  (ui.octaves - 1) / 2, ui.octaves + "");
    if (typeof print === "function") {
        print(0, 56, "P1 NEW   P2 MUT", 1);
    }
}

function drawScalePage() {
    const scaleName = SCALE_NAMES[ui.scale] || "?";
    const rootName = ROOT_NAMES[ui.root] || "?";
    if (typeof print === "function") {
        print(0, 0,  "SCALE", 1);
        print(0, 12, "Root:   " + rootName, 1);
        print(0, 22, "Scale:  " + scaleName, 1);
        print(0, 32, "Length: " + ui.length, 1);
        print(0, 42, "Gate:   " + Math.round(ui.gate * 100) + "%", 1);
        print(0, 56, "Knobs 5-8 adjust", 1);
    }
}

function drawHelpPage() {
    if (typeof print !== "function") return;
    print(0, 0,  "HELP / PAD MAP", 1);
    print(0, 10, "Top:   steps 1-16", 1);
    print(0, 20, "Mid:   banks (Shift save)", 1);
    print(0, 30, "Bot:  1NEW 2MUT 3DIR", 1);
    print(0, 38, "      4Ch- 5Ch+", 1);
    print(0, 46, "HW: +/- oct  X=CLR", 1);
    print(0, 54, "    Play=transport", 1);
}

function draw() {
    if (typeof clear_screen !== "function") return;
    clear_screen();
    switch (currentPage) {
        case PAGE_MUTATION: drawMutationPage(); break;
        case PAGE_SCALE:    drawScalePage();    break;
        case PAGE_HELP:     drawHelpPage();     break;
        default:            drawPerformPage();
    }
    // Overlay last so it sits on top of whatever the page drew.
    drawOverlay();
}

// -------- Lifecycle ----------

globalThis.init = function() {
    console.log("[tb3po] ui init");
};

globalThis.tick = function() {
    tickOverlay();
    pollDsp();
    refreshLeds();
    draw();
};

globalThis.onMidiMessageInternal = function(data) {
    if (!data) return;
    const status = data[0] | 0;
    const d1 = data[1] | 0;
    const d2 = data[2] | 0;
    const type = status & 0xF0;

    // Capacitive touch: notes 0-7 = knob touches, 8 = master touch, 9 = main jog.
    // Pop the param overlay on knob touch so the user sees the current value
    // BEFORE they turn and change it (this is what the core modules do).
    if ((type === 0x90 || type === 0x80) && d1 < 10) {
        if (type === 0x90 && d2 > 0 && d1 < 8) {
            const info = knobOverlayInfo(d1);
            if (info) showOverlay(info.name, info.value);
        }
        return;
    }
    if (type === 0xD0 || type === 0xA0) return;  // aftertouch
    if (status === 0xF8 || status === 0xF0 || status === 0xF7) return;  // clock/sysex

    // Track shift locally.
    if (type === 0xB0 && d1 === CC_SHIFT) {
        shiftHeld = (d2 > 0);
        return;
    }
    if (type === 0xB0 && d1 === CC_BACK) {
        // Host intercepts Back for suspend/exit. Release may leak through; ignore.
        return;
    }

    // X / Delete button = CLEAR. Deliberately mapped off the pad grid so it
    // takes a real reach to hit accidentally.
    if (type === 0xB0 && d1 === CC_DELETE && d2 > 0) {
        setDspParam("clear", "1");
        showOverlay("Pattern", "cleared");
        return;
    }

    // + / − buttons = octave up / down.
    if (type === 0xB0 && d1 === CC_DOWN && d2 > 0) {
        ui.transpose = Math.max(-48, (ui.transpose | 0) - 12);
        setDspParam("transpose", String(ui.transpose));
        showOverlay("Transpose", (ui.transpose / 12) + " oct");
        return;
    }
    if (type === 0xB0 && d1 === CC_UP && d2 > 0) {
        ui.transpose = Math.min( 48, (ui.transpose | 0) + 12);
        setDspParam("transpose", String(ui.transpose));
        showOverlay("Transpose", (ui.transpose / 12) + " oct");
        return;
    }

    // Left / Right buttons paginate the step grid when the pattern is > 16.
    if (type === 0xB0 && d1 === CC_LEFT && d2 > 0) {
        if (stepPageCount() > 1 && stepView > 0) {
            stepView--;
            showOverlay("Steps", (stepView * 16 + 1) + "-" + Math.min(ui.length, (stepView + 1) * 16));
        }
        return;
    }
    if (type === 0xB0 && d1 === CC_RIGHT && d2 > 0) {
        if (stepPageCount() > 1 && stepView < stepPageCount() - 1) {
            stepView++;
            showOverlay("Steps", (stepView * 16 + 1) + "-" + Math.min(ui.length, (stepView + 1) * 16));
        }
        return;
    }

    // Track 1 / Track 2 buttons switch knob mode.
    if (type === 0xB0 && d1 === CC_TRACK1 && d2 > 0) {
        controlMode = MODE_3PO;
        showOverlay("Knob mode", "3PO");
        return;
    }
    if (type === 0xB0 && d1 === CC_TRACK2 && d2 > 0) {
        controlMode = MODE_303;
        showOverlay("Knob mode", "303 CCs");
        return;
    }

    // Knob deltas arrive as synthetic CC messages (CC 71-78).
    if (type === 0xB0 && d1 >= CC_KNOB_BASE && d1 < CC_KNOB_BASE + 8) {
        const knobIdx = d1 - CC_KNOB_BASE;
        handleKnob(knobIdx, decodeDelta(d2));
        return;
    }

    // Step buttons (notes 16-31) — page selector.
    if (type === 0x90 && d1 >= NOTE_STEP_BASE && d1 < NOTE_STEP_BASE + NUM_STEP_BUTTONS && d2 > 0) {
        const stepIdx = d1 - NOTE_STEP_BASE;
        if (stepIdx >= 0 && stepIdx < NUM_PAGES) {
            currentPage = stepIdx;
        }
        return;
    }

    // Pads are note-on on notes 68-99. Velocity > 0 = real press.
    if (type === 0x90 && d1 >= NOTE_PAD_BASE && d1 <= NOTE_PAD_BASE + 31 && d2 > 0) {
        handlePadNoteOn(d1, d2);
        return;
    }
};

globalThis.onMidiMessageExternal = function(data) {
    // Not used in v0.1.
};

globalThis.onUnload = function() {
    // DSP destroy_instance handles note-offs.
    console.log("[tb3po] ui onUnload");
};
