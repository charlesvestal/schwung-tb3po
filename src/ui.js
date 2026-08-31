// TB-3PO UI — pad/knob/display bridge. All sequencing lives in dsp.so.

import {
    showOverlay, tickOverlay, drawOverlay, hideOverlay
} from '/data/UserData/schwung/shared/menu_layout.mjs';
import {
    setLED as sharedSetLED, setButtonLED as sharedSetButtonLED
} from '/data/UserData/schwung/shared/input_filter.mjs';
import {
    knobInit, knobStep,
    KNOB_TYPE_FLOAT, KNOB_TYPE_INT, KNOB_TYPE_ENUM
} from '/data/UserData/schwung/shared/knob_engine.mjs';
import { isReadOnly } from '/data/UserData/schwung/shared/param_pages/param_meta.mjs';
import { drawPage, META } from './pages.mjs';
/* ROOT_NAMES and SCALE_NAMES are no longer imported: the grid formats
 * an enum from its DECLARED options, so the names live in one place. */
import { ringFor, PAGE_PATTERN, LENGTHS, DIRECTIONS } from './params.mjs';

//
// Knobs (CC 71-78, relative encoders) edit params. Pads are arranged 4x8
// bottom-to-top: row 0 (notes 68-75) = actions, row 1 (76-83) = banks,
// row 2 (84-91) = steps 9-16, row 3 (92-99, top) = steps 1-8.
//
// Knob CCs arrive as accumulated synthetic messages from shadow_ui.js (see
// the overtake knob accumulator — positive count = CW, 128-value = CCW).

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
const CC_UNDO = 56;             // Move's Undo button
const CC_TRACK1 = 43;           // Track 1 button (reversed: CC43=T1, CC40=T4)
const CC_TRACK2 = 42;
const CC_TRACK3 = 41;
const CC_TRACK4 = 40;

// 303 CC map (matches schwung-303 plugin).
// Indexed by knob slot 0..7 → MIDI CC number.
const CC_303 = [74, 71, 75, 70, 16, 7, 12, 13];

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
// Per-slot state lives inside slots[i]; globals (bpm/running/syncSource)
// stay at the top level. A single slot for now — slot B comes in Task 3.
function makeSlot(defaults) {
    return Object.assign({
        position: 0,
        length: 16,
        density: 0.7,
        accent: 0.4,
        slide: 0.25,
        octaves: 2,
        root: 9,
        scale: 0,
        gate: 0.5,
        channel: 1,
        direction: 0,
        currentBank: 0,
        pendingRecall: -1,
        bankFilled: new Array(8).fill(false),
        transpose: 0,
        steps: new Array(32).fill(STEP_REST),
        cc303: new Array(8).fill(64),
        stepView: 0
    }, defaults || {});
}

let ui = {
    activeSlot: 0,
    slots: [makeSlot(), makeSlot({channel: 2})],
    bpm: 120,
    running: 1,
    syncSource: "INT"
};

function cur() { return ui.slots[ui.activeSlot]; }

let pollTick = 0;
let shiftHeld = false;

/* One ring per slot: the track buttons switch rings, and jog never crosses
 * the A/B boundary. That is what keeps a six-segment bank bar readable as a
 * map of this slot rather than as a scrollbar over both. */
let pageIndex = [0, 0];
export function ring() { return ringFor({ has303: has303Slot }); }
function curPage() { return ring()[clampPageIndex(ui.activeSlot)]; }
function clampPageIndex(slotIdx) {
    const n = ring().length;
    let i = pageIndex[slotIdx] | 0;
    if (i < 0) i = 0;
    if (i > n - 1) i = n - 1;
    pageIndex[slotIdx] = i;
    return i;
}

/* The grid puts the held knob's full name and value in the header strip, so
 * the overlay is no longer needed for it -- but the strip needs to know which
 * knob is under a finger. */
let touchedKnob = -1;

function stepPageCount() { return Math.max(1, Math.ceil(cur().length / 16)); }
function clampStepView()  { const m = stepPageCount() - 1; if (cur().stepView > m) cur().stepView = m; if (cur().stepView < 0) cur().stepView = 0; }

// -------- DSP bridge ----------

// Per-slot DSP params are namespaced with "a." / "b." prefixes so one DSP
// instance can host two independent slots (Task 3). For Task 2 only "a."
// is produced — the DSP strips the prefix at the dispatch entry. Globals
// (bpm, running, sync_source, etc.) stay bare.
function slotKey(k) { return (ui.activeSlot === 0 ? "a." : "b.") + k; }

// DEBUG: detect the "shim miss" failure where host_module_set_param /
// host_module_get_param have been deleted out from under us by a wrong
// suspend/teardown branch in shadow_ui.js while suspend_keeps_js keeps
// tick() firing. Without this log, every set/get becomes a silent no-op
// and the UI looks "disconnected from the DSP".
// Confirmed root cause 2026-04-29; if SHIM MISS fires, check
// schwung/src/shadow/shadow_ui.js exitToolOvertake + TOOLS flag handler
// for the suspendedOvertakes eviction fix.
let __shimMissCount = 0;
let __shimMissLastLogged = {};
function __logShimMiss(kind, key) {
    __shimMissCount++;
    const now = Date.now();
    const tag = kind + ":" + key;
    if ((now - (__shimMissLastLogged[tag] || 0)) < 2000) return;
    __shimMissLastLogged[tag] = now;
    console.log("[tb3po] SHIM MISS " + kind + " key=" + key + " count=" + __shimMissCount);
}

function setDspParam(key, val) {
    if (typeof host_module_set_param === "function") {
        host_module_set_param(key, String(val));
    } else {
        __logShimMiss("set", key);
    }
}

function getDspParam(key) {
    if (typeof host_module_get_param === "function") {
        return host_module_get_param(key);
    }
    __logShimMiss("get", key);
    return null;
}

function parsePattern(s) {
    if (!s) return;
    const parts = s.split("|");
    if (parts.length < 2) return;
    const len = parseInt(parts[0], 10);
    if (isFinite(len) && len > 0) cur().length = len;
    const stepsCsv = parts[1].split(",");
    const slot = cur();
    for (let i = 0; i < stepsCsv.length && i < slot.steps.length; i++) {
        slot.steps[i] = parseInt(stepsCsv[i], 10) | 0;
    }
}

let __dspNullStreak = 0;
function pollDsp() {
    const pos = getDspParam(slotKey("position"));
    if (pos !== null && pos !== "") {
        if (__dspNullStreak >= 50) {
            console.log("[tb3po] DSP READ RECOVERED after " + __dspNullStreak + " null reads");
        }
        __dspNullStreak = 0;
        cur().position = parseInt(pos, 10) | 0;
    } else {
        __dspNullStreak++;
        if (__dspNullStreak === 50 || __dspNullStreak === 500 ||
            (__dspNullStreak > 500 && (__dspNullStreak % 5000) === 0)) {
            console.log("[tb3po] DSP READ STUCK streak=" + __dspNullStreak +
                        " activeSlot=" + ui.activeSlot + " shimMiss=" + __shimMissCount);
        }
    }
    if ((pollTick % 10) === 0) {
        parsePattern(getDspParam(slotKey("pattern")));
        const bank = getDspParam(slotKey("current_bank"));
        if (bank !== null && bank !== "") cur().currentBank = parseInt(bank, 10) | 0;
        const pending = getDspParam(slotKey("pending_recall"));
        if (pending !== null && pending !== "") cur().pendingRecall = parseInt(pending, 10) | 0;
        const running = getDspParam("running");
        if (running !== null && running !== "") ui.running = parseInt(running, 10) | 0;
    }
    if ((pollTick % 30) === 0) {
        const bf = getDspParam(slotKey("bank_filled"));
        if (bf && typeof bf === "string") {
            const slot = cur();
            for (let i = 0; i < slot.bankFilled.length; i++) {
                slot.bankFilled[i] = (bf[i] === "1");
            }
        }
        const ss = getDspParam("sync_source");
        if (ss === "EXT" || ss === "INT") ui.syncSource = ss;
        // Re-assert per-slot output channel to the DSP. The UI owns this
        // setting, but init() only runs on first load — on resume the overtake
        // DSP can be reloaded (single-tenant slot 0) and come back on a stale
        // channel without init re-running, silently routing notes to a channel
        // no synth is listening on. Re-pushing here keeps the DSP on the
        // channel the UI shows through load, resume, and DSP reloads. The DSP's
        // "channel" set_param is side-effect-free, so re-asserting an unchanged
        // value is a harmless no-op.
        setDspParam("a.channel", String(ui.slots[0].channel));
        setDspParam("b.channel", String(ui.slots[1].channel));
    }

    // Re-scan for a 303 slot every ~1.4 sec so Track 2 / 303-mode UX reflects
    // reality: hidden when no 303 is loaded, visible when one is loaded later.
    if ((pollTick % 60) === 0) {
        /* The 303 page is PRESENT or ABSENT, so a plugin appearing or leaving
         * changes the ring's LENGTH -- and every index behind the 303 page
         * then names a different page. Resolve by NAME across the change
         * rather than clamping an index that has silently moved. */
        const wasNames = [ring()[clampPageIndex(0)].name, ring()[clampPageIndex(1)].name];
        cc303SlotIdx = find303Slot();
        const prev = has303Slot;
        has303Slot = cc303SlotIdx >= 0;
        if (prev !== has303Slot) {
            const r = ring();
            for (let sIdx = 0; sIdx < 2; sIdx++) {
                let found = r.findIndex((pg) => pg.name === wasNames[sIdx]);
                if (found < 0) found = r.findIndex((pg) => pg.name === "Pattern");
                pageIndex[sIdx] = found < 0 ? 0 : found;
            }
            if (prev && wasNames[ui.activeSlot] === "303") {
                showOverlay("303 unloaded", "page removed");
            }
        }
    }
    pollTick++;
}

// -------- Knob handling ----------

// Shadow UI batches encoder ticks per frame (~22ms) and encodes the
// accumulated count as the CC value (CW = 1..63, CCW = 65..127). The
// per-frame batched count is fed as `direction` to knob_engine, which
// applies the unified divisor curve (fine when slow, accumulating when
// fast) and the 10-tick-per-option enum budget shared with schwung.
function decodeDelta(value) {
    if (value === 0 || value === 64) return 0;
    if (value <= 63) return value;
    return -(128 - value);
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Per-key knob_engine state. Keyed by uiKey (per-slot would multiply state
// for a feature nobody asks for; the slot's current value is re-synced into
// the engine on every tick anyway).
const knobStates = new Map();
function getKnobState(key, currentValue) {
    let st = knobStates.get(key);
    if (!st) {
        st = knobInit(currentValue);
        knobStates.set(key, st);
    } else {
        st.value = currentValue;
    }
    return st;
}

function adjustFloat(key, uiKey, delta, step, lo, hi) {
    const slot = cur();
    const st = getKnobState(uiKey, slot[uiKey]);
    const cfg = { type: KNOB_TYPE_FLOAT, min: lo, max: hi, step };
    const next = knobStep(st, cfg, delta, Date.now());
    if (next !== slot[uiKey]) {
        slot[uiKey] = next;
        setDspParam(slotKey(key), next.toFixed(3));
    }
}

function adjustInt(key, uiKey, delta, lo, hi, step) {
    const slot = cur();
    const st = getKnobState(uiKey, slot[uiKey] | 0);
    const cfg = { type: KNOB_TYPE_INT, min: lo, max: hi, step: step > 0 ? step : 1 };
    const next = knobStep(st, cfg, delta, Date.now());
    if (next !== slot[uiKey]) {
        slot[uiKey] = next;
        setDspParam(slotKey(key), String(next));
    }
}

/* Tiny int ranges (e.g. octaves 1..3) feel like enums — route them through
 * the engine's enum branch so each option needs the full enum tick budget
 * instead of the int divisor. */
function adjustIntAsEnum(key, uiKey, delta, lo, hi) {
    const slot = cur();
    const count = hi - lo + 1;
    const curIdx = clamp((slot[uiKey] | 0) - lo, 0, count - 1);
    const st = getKnobState(uiKey, curIdx);
    const cfg = { type: KNOB_TYPE_ENUM, min: 0, max: count - 1, step: 1, enumCount: count };
    const nextIdx = knobStep(st, cfg, delta, Date.now());
    const next = nextIdx + lo;
    if (next !== slot[uiKey]) {
        slot[uiKey] = next;
        setDspParam(slotKey(key), String(next));
    }
}

function adjustEnum(key, uiKey, delta, count) {
    const slot = cur();
    const st = getKnobState(uiKey, slot[uiKey] | 0);
    const cfg = { type: KNOB_TYPE_ENUM, min: 0, max: count - 1, step: 1, enumCount: count };
    const next = knobStep(st, cfg, delta, Date.now());
    if (next !== slot[uiKey]) {
        slot[uiKey] = next;
        setDspParam(slotKey(key), String(next));
    }
}

function adjustLength(delta) {
    const slot = cur();
    const idx = LENGTHS.indexOf(slot.length);
    const curIdx = idx < 0 ? 1 : idx;
    const st = getKnobState("length", curIdx);
    const cfg = { type: KNOB_TYPE_ENUM, min: 0, max: LENGTHS.length - 1, step: 1, enumCount: LENGTHS.length };
    const nextIdx = knobStep(st, cfg, delta, Date.now());
    const next = LENGTHS[nextIdx];
    if (next !== slot.length) {
        slot.length = next;
        setDspParam(slotKey("length"), String(next));
    }
}

let patternStale = false;  // true when prob-knobs have changed since last generate

/*
 * AN OVERLAY IS FOR SOMETHING THE SCREEN DOES NOT ALREADY SHOW.
 *
 * It existed on every knob turn because the old UI drew no knobs at all, so a
 * modal box was the only feedback there was. The grid draws the value in the
 * cell and puts the held param's full name and value in the header strip, so
 * the same box now lands ON TOP of the cell being turned -- it hides the one
 * thing the user is looking at.
 *
 * So knob turns, jog page changes, step-button page jumps and slot switches
 * are all silent now: the header names the slot and the page, and the bank bar
 * says where that page sits. What KEEPS an overlay is a pad or button whose
 * effect has no cell on the page you happen to be on -- bank save/recall,
 * regenerate, mutate, direction, channel, clear, undo, transpose.
 */

/* The step window is the one page-ish change that is NOT always visible:
 * PERFORM's header reads "Steps 17-32", but every other page shows no big
 * lane, so there the button moves something with nothing on screen to see. */
function announceStepWindow() {
    if (curPage().kind === "perform") return;
    const slot = cur();
    showOverlay("Steps", (slot.stepView * 16 + 1) + "-" +
                Math.min(slot.length, (slot.stepView + 1) * 16));
}

/* Jog turns PAGES. Editing a list with the jog is retired -- every value is
 * edited by the knob above it, which is what the grid is for. */
function handleJogTurn(delta) {
    if (delta === 0) return;
    const n = ring().length;
    const step = delta > 0 ? 1 : -1;
    pageIndex[ui.activeSlot] = (clampPageIndex(ui.activeSlot) + step + n) % n;
}

/*
 * Which key each physical knob edits on the page currently shown.
 *
 * PERFORM inherits Pattern's ROW 0 -- the same four in the same positions, or
 * knob 4 would mean Octaves on one page and Gate on another. Knobs 5-8 are
 * inert there, and only one row is drawn, so the page shows what its knobs do.
 */
export function keyForKnob(idx) {
    if (!(idx >= 0 && idx < 8)) return null;
    const page = curPage();
    if (page.kind === "perform") return idx < 4 ? PAGE_PATTERN.keys[idx] : null;
    if (page.kind === "knobs") return page.keys[idx] || null;
    return null;
}

/*
 * The declared key -> the slot field that holds it.
 *
 * The 303 page's keys are absent on purpose: their write path is send303Cc,
 * keyed by KNOB INDEX and sending a CC to another chain slot, so they never
 * reach editKey. The declaration exists for the GRID -- widget, label, value.
 */
const KEY_FIELD = {
    density: "density", accent: "accent", slide: "slide", gate: "gate",
    root: "root", scale: "scale", length: "length", octaves: "octaves",
    channel: "channel", direction: "direction", transpose: "transpose",
};

/* Keys whose value only takes effect on the NEXT generation. */
const STALE_KEYS = new Set(["density", "accent", "slide", "octaves"]);

/*
 * Route a declared key onto the existing adjust* helpers using its own
 * metadata, so the grid's description of a param and the edit that param
 * receives come from ONE declaration.
 */
function editKey(key, delta) {
    /* `length` is an enum of INDICES to the grid and a step COUNT to the DSP;
     * adjustLength is the only place that projection lives. */
    if (key === "length") { adjustLength(delta); return; }
    const field = KEY_FIELD[key];
    if (!field) return;
    const meta = META.getOrGuess(key);
    if (meta.type === "enum") {
        const n = Array.isArray(meta.options) ? meta.options.length : 0;
        if (n > 0) adjustEnum(key, field, delta, n);
        return;
    }
    if (meta.type === "int") {
        const step = meta.step > 0 ? meta.step : 1;
        const span = (meta.max - meta.min) / step;
        /* Tiny ranges (octaves 1..3) feel like enums. */
        if (step === 1 && span <= 8) { adjustIntAsEnum(key, field, delta, meta.min, meta.max); return; }
        adjustInt(key, field, delta, meta.min, meta.max, step);
        return;
    }
    adjustFloat(key, field, delta, meta.step > 0 ? meta.step : 0.01, meta.min, meta.max);
}


function handleKnob(knobIdx, delta) {
    if (delta === 0) return;
    const key = keyForKnob(knobIdx);
    if (!key) return;
    /*
     * A READOUT shows its reading and writes nothing.
     *
     * The shadow UI does this for chain components in isReadoutParam, but
     * TB-3PO is a TOOL with its OWN knob dispatch, so it gets none of that for
     * free and has to honour `access: "read"` itself -- otherwise turning the
     * Bank cell would write current_bank, which the DSP does not accept.
     */
    if (isReadOnly(META.getOrGuess(key))) return;
    /*
     * The 303 page writes by CC to ANOTHER chain slot, keyed by knob index --
     * the "303." prefix is stripped by never being used as a write target.
     */
    if (curPage().name === "303") {
        send303Cc(knobIdx, delta);
    } else {
        editKey(key, delta);
        if (STALE_KEYS.has(key)) patternStale = true;
    }
}

// Slot that currently hosts the 303 plugin. Refreshed on 303-mode entry and
// periodically so the UI can hide/disable 303 mode when no 303 is loaded.
let cc303SlotIdx = -1;
let has303Slot = false;

// Param keys 303 plugin exposes via get_param, matching CC_303 index order.
// Note: CC 12/13 on the 303 were "overdrive_level"/"overdrive_dry_wet" in
// pre-0.3.0 and are now "drive"/"drive_mix" (same CCs, renamed params since
// the LSTM overdrive was replaced with the Soft/RAT drive stage).
const CC_303_PARAM_KEYS = [
    "cutoff", "resonance", "decay", "env_mod",
    "accent", "volume", "drive", "drive_mix"
];

function find303Slot() {
    if (typeof shadow_get_param !== "function") return -1;
    for (let s = 0; s < 4; s++) {
        const mod = shadow_get_param(s, "synth_module");
        if (mod === "303") return s;
    }
    return -1;
}

function sync303FromPlugin() {
    // Pull the 303's current param values into cur().cc303 (0..127) so the
    // first knob turn doesn't jump the synth, and so the displayed value
    // actually reflects reality.
    if (typeof shadow_get_param !== "function") return;
    if (cc303SlotIdx < 0) cc303SlotIdx = find303Slot();
    if (cc303SlotIdx < 0) return;
    const slot = cur();
    for (let i = 0; i < CC_303_PARAM_KEYS.length; i++) {
        const v = shadow_get_param(cc303SlotIdx, CC_303_PARAM_KEYS[i]);
        if (v === null || v === "") continue;
        const fv = parseFloat(v);
        if (!isFinite(fv)) continue;
        slot.cc303[i] = Math.round(clamp(fv * 127, 0, 127));
    }
}

function send303Cc(knobIdx, delta) {
    const cc = CC_303[knobIdx];
    if (cc === undefined || delta === 0) return;
    const slot = cur();
    const cur303 = slot.cc303[knobIdx] | 0;
    const st = getKnobState("303:" + knobIdx, cur303);
    const cfg = { type: KNOB_TYPE_INT, min: 0, max: 127, step: 1 };
    const next = knobStep(st, cfg, delta, Date.now());
    if (next === cur303) return;
    slot.cc303[knobIdx] = next;
    if (typeof shadow_send_midi_to_dsp === "function") {
        const chStatus = 0xB0 | ((slot.channel - 1) & 0x0F);
        shadow_send_midi_to_dsp([chStatus, cc, next]);
    }
}

/*
 * Slot AND page, not slot and mode.
 *
 * 3PO vs 303 was a KNOB mode because there was nowhere to show it; it is two
 * pages now and the header names them. With no 303 reachable the 303 page is
 * absent from the ring, so T2/T4 land on Pattern -- there is nothing to refuse
 * and no overlay explaining a refusal.
 *
 * The 303 scan is forced here so a just-loaded 303 is picked up without
 * waiting for the ~1.4 s poll.
 */
function selectSlotPage(slotIdx, pageName) {
    if (pageName === "303") {
        cc303SlotIdx = find303Slot();
        has303Slot = cc303SlotIdx >= 0;
    }
    ui.activeSlot = slotIdx;
    setDspParam("active_slot", String(slotIdx));
    const r = ring();
    let found = r.findIndex((pg) => pg.name === pageName);
    if (found < 0) found = r.findIndex((pg) => pg.name === "Pattern");
    pageIndex[slotIdx] = found < 0 ? 0 : found;
    if (pageName === "303" && has303Slot) sync303FromPlugin();
}

// -------- Pad handling ----------

function cycleStepState(stepIdx) {
    const slot = cur();
    if (stepIdx < 0 || stepIdx >= slot.length) return;
    const prev = slot.steps[stepIdx] | 0;
    const next = (prev + 1) & 3;  // rest → note → accent → slide → rest
    slot.steps[stepIdx] = next;
    setDspParam(slotKey("set_step"), stepIdx + ":" + next);
}

function handlePadNoteOn(note, vel) {
    if (vel === 0) return;  // release
    const padIdx = note - NOTE_PAD_BASE;
    if (padIdx < 0 || padIdx > 31) return;
    const row = Math.floor(padIdx / 8);  // 0 bottom, 3 top
    const col = padIdx % 8;
    const slot = cur();

    if (row === 3) {                     // top row: first 8 steps of current page
        cycleStepState(slot.stepView * 16 + col);
    } else if (row === 2) {              // next 8 steps of current page
        cycleStepState(slot.stepView * 16 + 8 + col);
    } else if (row === 1) {              // banks (Shift = store, plain = recall-at-next-bar)
        const bn = col + 1;
        if (shiftHeld) {
            setDspParam(slotKey("store_bank"), String(col));
            slot.currentBank = col;
            showOverlay("Bank " + bn, "saved");
        } else {
            if (ui.running) {
                /* Queue the recall; DSP applies at next bar boundary. */
                setDspParam(slotKey("recall_bank"), String(col));
                slot.pendingRecall = col;
                showOverlay("Bank " + bn, "queued");
            } else {
                /* Transport stopped — no bar boundary coming, apply now. */
                setDspParam(slotKey("recall_bank_now"), String(col));
                slot.currentBank = col;
                slot.pendingRecall = -1;
                showOverlay("Bank " + bn, "recalled");
            }
        }
    } else {                             // row 0: actions
        switch (col) {
            case 0:
                setDspParam(slotKey("generate"), "0");
                patternStale = false;
                showOverlay("Pattern", "regenerated");
                break;
            case 1:
                setDspParam(slotKey("mutate"), "1");
                showOverlay("Pattern", "mutated");
                break;
            case 2:
                slot.direction = (slot.direction + 1) & 3;
                setDspParam(slotKey("direction"), String(slot.direction));
                showOverlay("Direction", DIRECTIONS[slot.direction] || "?");
                break;
            case 3:
                adjustInt("channel", "channel", -1, 1, 16);
                showOverlay("Channel", String(cur().channel));
                break;
            case 4:
                adjustInt("channel", "channel", +1, 1, 16);
                showOverlay("Channel", String(cur().channel));
                break;
            default: break;
        }
    }
}

// -------- LED feedback ----------
// Use the shared setLED / setButtonLED helpers from input_filter.mjs — same
// note/CC dedup the other overtake modules use. The shadow-side LED queue
// only flushes 16 LEDs per tick, so deduping is required; blasting 40+ unique
// LEDs every frame starves the queue (was the "LEDs don't work at all" bug).
//
// Force-refresh-on-gap: if the tick loop was idle for >500ms we probably
// just came out of suspend, and hardware state may have drifted. Set a flag
// and pass force=true to every LED write for that one tick so everything
// repaints.

let lastRefreshMs = 0;
let ledForceNextRefresh = true;  // also true on first paint

function padNote(row, col) { return NOTE_PAD_BASE + row * 8 + col; }

function setLed(row, col, color) {
    sharedSetLED(padNote(row, col), color & 0x7F, ledForceNextRefresh);
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
    sharedSetLED(NOTE_STEP_BASE + idx, color & 0x7F, ledForceNextRefresh);
}

function setTrackLed(cc, color) {
    sharedSetButtonLED(cc, color & 0x7F, ledForceNextRefresh);
}

// Colour a track button for (slot, page): bright when that slot is active AND
// showing that page, dim when not, off for 303 buttons with no 303 loaded.
function trackLed(slotIdx, pageName) {
    if (pageName === "303" && !has303Slot) return LED_OFF;
    const active = (ui.activeSlot === slotIdx && curPage().name === pageName);
    if (!active) return LED_DARK_GREY;
    return pageName === "Pattern" ? LED_TEAL : LED_ORANGE;
}

function refreshLeds() {
    clampStepView();
    // Force a full repaint every ~2 sec unconditionally. Tick fires during
    // suspend too, so we can't rely on a gap; a periodic unconditional
    // refresh is the simplest fix for LEDs drifting away from our cache
    // (e.g. after Move firmware wrote over them during suspend).
    if ((pollTick % 88) === 0) ledForceNextRefresh = true;
    // Also detect a large wall-clock gap — faster recovery in the case where
    // tick does actually stop (JS frozen during some other suspend variant).
    const now = Date.now();
    if (lastRefreshMs > 0 && (now - lastRefreshMs) > 500) {
        ledForceNextRefresh = true;
    }
    lastRefreshMs = now;
    const slot = cur();
    const pageBase = slot.stepView * 16;

    // Rows 2 & 3 — step grid for the current 16-step page. Cursor = bright
    // Use YELLOW for the cursor — white collided with plain NOTE steps which
    // are also white, making the cursor invisible on those pads.
    for (let col = 0; col < 8; col++) {
        const step = pageBase + col;
        let color = (step < slot.length) ? stepLedColor(slot.steps[step]) : LED_OFF;
        if (ui.running && step === slot.position) color = LED_YELLOW;
        setLed(3, col, color);
    }
    for (let col = 0; col < 8; col++) {
        const step = pageBase + 8 + col;
        let color = (step < slot.length) ? stepLedColor(slot.steps[step]) : LED_OFF;
        if (ui.running && step === slot.position) color = LED_YELLOW;
        setLed(2, col, color);
    }

    // Row 1 — banks. Current = bright purple, filled = teal, empty = off.
    // Queued recall flashes between bright yellow and its normal colour.
    // While Shift is held, the row shifts to red/pink to signal "SAVE slots".
    const flashPhase = Math.floor(pollTick / 4) & 1;
    for (let col = 0; col < 8; col++) {
        let color;
        if (shiftHeld) {
            // Save-mode cue — all slots pulse red so the user sees "these
            // are save targets now".
            color = (col === slot.currentBank) ? LED_WHITE : (flashPhase ? LED_RED : LED_PINK);
        } else if (col === slot.pendingRecall && flashPhase) {
            color = LED_YELLOW;
        } else if (col === slot.currentBank) {
            color = LED_PURPLE;
        } else if (slot.bankFilled[col]) {
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

    // Step buttons — page selector, one per page in the CURRENT ring (five or
    // six, depending on whether a 303 is reachable). Available = white,
    // current = green.
    const pageCount = ring().length;
    const shownPage = clampPageIndex(ui.activeSlot);
    for (let i = 0; i < NUM_STEP_BUTTONS; i++) {
        if (i < pageCount) {
            setStepLed(i, (i === shownPage) ? LED_GREEN : LED_WHITE);
        } else {
            setStepLed(i, LED_OFF);
        }
    }

    // Track buttons 1..4 — slot + page. One is bright (the active slot showing
    // that page), the others dim. T2/T4 stay dark when no 303 is reachable.
    setTrackLed(CC_TRACK1, trackLed(0, "Pattern"));
    setTrackLed(CC_TRACK2, trackLed(0, "303"));
    setTrackLed(CC_TRACK3, trackLed(1, "Pattern"));
    setTrackLed(CC_TRACK4, trackLed(1, "303"));

    // Hardware buttons tb3po owns. Play is intentionally NOT set here —
    // we want Move firmware to drive it (passthrough capability).
    setTrackLed(CC_UP,     LED_DARK_GREY);                 // +  octave up
    setTrackLed(CC_DOWN,   LED_DARK_GREY);                 // -  octave down
    setTrackLed(CC_LEFT,   stepPageCount() > 1 ? LED_DARK_GREY : LED_OFF);
    setTrackLed(CC_RIGHT,  stepPageCount() > 1 ? LED_DARK_GREY : LED_OFF);
    setTrackLed(CC_SHIFT,  LED_WHITE);                     // Shift modifier
    setTrackLed(CC_BACK,   LED_WHITE);                     // Back / suspend
    setTrackLed(CC_DELETE, LED_WHITE);                     // X  CLEAR (Shift+X to confirm)
    setTrackLed(CC_UNDO,   LED_DARK_GREY);                 // Undo last op

    // Clear the force-refresh flag now that all LEDs have been written.
    ledForceNextRefresh = false;
}

// -------- Display ----------

function draw() {
    if (typeof clear_screen !== "function") return;
    clear_screen();
    clampStepView();
    const fb = { fillRect: fill_rect };
    const ctx = { fillRect: fill_rect, print: print, textWidth: text_width, line: draw_line };
    const slot = cur();
    const r = ring();
    const idx = clampPageIndex(ui.activeSlot);
    /* A knob with no key on this page has no cell to strip, and Setup's
     * knobs 5-8 have no key at all -- so the touch is reported only where
     * there is something for it to highlight. */
    const touched = keyForKnob(touchedKnob) ? touchedKnob : -1;
    drawPage(fb, ctx, {
        slotLabel: "Slot " + (ui.activeSlot === 0 ? "A" : "B"),
        bpm: ui.bpm,
        ring: r,
        pageIndex: idx,
        steps: slot.steps,
        position: slot.position,
        stepView: slot.stepView,
        shiftHeld: shiftHeld,
        touched: touched,
        values: dspValues(slot)
    });
    // Overlay last so it sits on top of whatever the page drew.
    drawOverlay();
}

/* The grid reads values by KEY, so the slot's fields are projected onto the
 * declared keys rather than the grid being taught about slots.
 *
 * `length` is an enum of INDICES to the grid and a step COUNT on the slot, so
 * it is projected back through LENGTHS here -- the inverse of adjustLength. */
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
        current_bank: slot.currentBank + 1
    };
}

// -------- Lifecycle ----------

globalThis.init = function() {
    console.log("[tb3po] ui init");
    // Reconcile the per-slot output channel down to the DSP on load.
    // The UI owns the channel setting but, until now, only pushed it to the
    // DSP from the channel-edit handler — never on init/resume. The DSP boots
    // (or restores) on its own channel, so on load it could emit on a channel
    // that no synth is listening to: notes route nowhere and the slot synth
    // stays silent, even though the UI shows the "right" channel. The only
    // thing that fixed it was nudging the channel (which calls setDspParam).
    // Assert both slots' channels here so the DSP matches what the UI shows
    // from the first frame — same effect as the manual nudge, automatically.
    setDspParam("a.channel", String(ui.slots[0].channel));
    setDspParam("b.channel", String(ui.slots[1].channel));
    // First-load nudge — call out the four-button slot/mode scheme so the
    // user understands two slots (A/B) run in parallel on separate channels.
    showOverlay("Slots A+B", "T1/T2 A, T3/T4 B", 360);

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
    // The grid puts the held knob's full name and value in the header strip,
    // so the overlay is no longer popped here -- the strip needs only to know
    // which knob is under a finger.
    if ((type === 0x90 || type === 0x80) && d1 < 10) {
        if (d1 < 8) {
            if (type === 0x90 && d2 > 0) touchedKnob = d1;
            else if (touchedKnob === d1) touchedKnob = -1;
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

    // X / Delete button = CLEAR, but GATED behind Shift so a stray press
    // on the hardware button doesn't wipe a pattern. Plain X nudges the user.
    if (type === 0xB0 && d1 === CC_DELETE && d2 > 0) {
        if (shiftHeld) {
            setDspParam(slotKey("clear"), "1");
            showOverlay("Pattern", "cleared");
        } else {
            showOverlay("Clear", "Shift+X to confirm");
        }
        return;
    }

    // Undo button — restore the pattern before the last NEW / MUTATE / CLEAR.
    if (type === 0xB0 && d1 === CC_UNDO && d2 > 0) {
        setDspParam(slotKey("undo"), "1");
        showOverlay("Undo", "last pattern op");
        return;
    }

    // + / − buttons = octave up / down.
    if (type === 0xB0 && d1 === CC_DOWN && d2 > 0) {
        const slot = cur();
        slot.transpose = Math.max(-48, (slot.transpose | 0) - 12);
        setDspParam(slotKey("transpose"), String(slot.transpose));
        showOverlay("Transpose", (slot.transpose / 12) + " oct");
        return;
    }
    if (type === 0xB0 && d1 === CC_UP && d2 > 0) {
        const slot = cur();
        slot.transpose = Math.min( 48, (slot.transpose | 0) + 12);
        setDspParam(slotKey("transpose"), String(slot.transpose));
        showOverlay("Transpose", (slot.transpose / 12) + " oct");
        return;
    }

    // Left / Right buttons paginate the step grid when the pattern is > 16.
    if (type === 0xB0 && d1 === CC_LEFT && d2 > 0) {
        const slot = cur();
        if (stepPageCount() > 1 && slot.stepView > 0) {
            slot.stepView--;
            announceStepWindow();
        }
        return;
    }
    if (type === 0xB0 && d1 === CC_RIGHT && d2 > 0) {
        const slot = cur();
        if (stepPageCount() > 1 && slot.stepView < stepPageCount() - 1) {
            slot.stepView++;
            announceStepWindow();
        }
        return;
    }

    // Track 1-4 buttons select (slot, page). T1/T2 = slot A Pattern/303,
    // T3/T4 = slot B Pattern/303. active_slot is a global DSP param (no a./b.
    // prefix) so the DSP knows which channel the 303-Control CC path rides.
    if (type === 0xB0 && d2 > 0) {
        if      (d1 === CC_TRACK1) { selectSlotPage(0, "Pattern"); return; }
        else if (d1 === CC_TRACK2) { selectSlotPage(0, "303");     return; }
        else if (d1 === CC_TRACK3) { selectSlotPage(1, "Pattern"); return; }
        else if (d1 === CC_TRACK4) { selectSlotPage(1, "303");     return; }
    }

    // Knob deltas arrive as synthetic CC messages (CC 71-78).
    if (type === 0xB0 && d1 >= CC_KNOB_BASE && d1 < CC_KNOB_BASE + 8) {
        const knobIdx = d1 - CC_KNOB_BASE;
        handleKnob(knobIdx, decodeDelta(d2));
        return;
    }

    // Jog wheel (CC 14) — turns PAGES, on every page. Jog click (CC 3) is
    // left entirely to the host's exit combo.
    if (type === 0xB0 && d1 === 14) {
        handleJogTurn(decodeDelta(d2));
        return;
    }

    // Step buttons (notes 16-31) — page selector, clamped to the ring, which
    // is five or six long depending on whether a 303 is reachable.
    if (type === 0x90 && d1 >= NOTE_STEP_BASE && d1 < NOTE_STEP_BASE + NUM_STEP_BUTTONS && d2 > 0) {
        const stepIdx = d1 - NOTE_STEP_BASE;
        if (stepIdx >= 0 && stepIdx < ring().length) {
            pageIndex[ui.activeSlot] = stepIdx;
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

/*
 * Exported for tests/ui_smoke.mjs ONLY.
 *
 * Nothing on the device imports this module -- the host loads it with
 * shadow_load_ui_module and reads globalThis -- so a named export costs
 * nothing at runtime and is the smallest way to make the module-level wiring
 * (which knob edits which key, and what a turn writes) assertable. `ring` and
 * `keyForKnob` are exported at their declarations above.
 */
export const __test = {
    ui, pageIndex, handleKnob, dspValues, curPage, editKey,
    metaFor: (key) => META.getOrGuess(key),
    keyField: (key) => KEY_FIELD[key],
};
