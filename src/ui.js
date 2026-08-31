// TB-3PO UI — pad/knob/display bridge. All sequencing lives in dsp.so.

import {
    showOverlay, tickOverlay, drawOverlay, hideOverlay
} from '/data/UserData/schwung/shared/menu_layout.mjs';
import {
    setLED as sharedSetLED, setButtonLED as sharedSetButtonLED
} from '/data/UserData/schwung/shared/input_filter.mjs';
import { decodeDelta } from '/data/UserData/schwung/shared/input_filter.mjs';
/*
 * THE SHARED KNOB GRID, WHOLE.
 *
 * TB-3PO used to drive `renderPageMovy` directly and hand-roll everything
 * around it: the page set, the knob->key dispatch, touch tracking, a readout
 * guard, a knob_engine call per param type and a dive picker. Every one of
 * those already existed in `page_controller.mjs`, so what TB-3PO had was a
 * second implementation of it -- and second implementations lose the parts
 * nobody re-derived. Here that was the widget animation store, the write and
 * announce throttles, the staggered read cursor, and every graphic.
 *
 * `createController` is now the whole binding: it plans the pages from the
 * contract TB-3PO publishes to itself (see params.mjs `hierarchyFor`),
 * dispatches the knobs, owns the knob engine, holds the values, and draws the
 * BODY of a knob page. TB-3PO keeps its chrome, its pads, its LEDs and its
 * four non-knob pages. `page_input.mjs` turns Move's MIDI into intents so the
 * decoding is not a third copy either.
 *
 * The pattern, and the reasoning behind every part of it, is
 * schwung-movy-embed's `src/renderer/schwung-page.ts` -- another project that
 * made this exact mistake and undid it.
 */
import { createController, LAYOUT_MOVY }
    from '/data/UserData/schwung/shared/param_pages/page_controller.mjs';
import { decodeInput, applyInput }
    from '/data/UserData/schwung/shared/param_pages/page_input.mjs';
import { drawEnumList } from '/data/UserData/schwung/shared/param_pages/enum_list.mjs';
import { drawPage, PERFORM_KNOBS } from './pages.mjs';
/* ROOT_NAMES and SCALE_NAMES are no longer imported: the grid formats
 * an enum from its DECLARED options, so the names live in one place. */
import { pagesFor, hierarchyFor, controllerPageFor, TB3PO_PARAMS, DIRECTIONS }
    from './params.mjs';

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
/*
 * Jog click.
 *
 * It was unhandled, on the note that it belonged to "the host's exit combo" --
 * but that combo is Shift+Vol+JogClick, and shadow_ui.js only claims the click
 * when BOTH modifiers are down (the `hostShiftHeld && hostVolumeKnobTouched`
 * test above its forward to onMidiMessageInternal). A PLAIN click is not
 * accumulated like the knobs and jog turn are, and falls straight through to
 * us. So the free gesture the shared UI spends on "dive into the cell under
 * your hand" is free here too.
 */
const CC_JOG_CLICK = 3;
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

/* One pages per slot: the track buttons switch rings, and jog never crosses
 * the A/B boundary. That is what keeps a six-segment bank bar readable as a
 * map of this slot rather than as a scrollbar over both. */
let pageIndex = [0, 0];
export function pages() { return pagesFor({ has303: has303Slot }); }
function curPage() { return pages()[clampPageIndex(ui.activeSlot)]; }
function clampPageIndex(slotIdx) {
    const n = pages().length;
    let i = pageIndex[slotIdx] | 0;
    if (i < 0) i = 0;
    if (i > n - 1) i = n - 1;
    pageIndex[slotIdx] = i;
    return i;
}

/* ================= THE SHARED PAGE CONTROLLER =================
 *
 * TB-3PO IS ITS OWN MODULE. The controller does no param I/O of its own -- rule
 * one of param_pages -- so every read and write below answers out of this
 * file's state and never touches IPC. `synth:ui_hierarchy` and
 * `synth:chain_params` are the contract TB-3PO declares for itself; everything
 * else is a slot field.
 *
 * The prefix is the default "synth", so the keys arriving here are
 * "synth:<key>" and this is the one place the prefix is stripped.
 */
const PREFIX = "synth:";
const bareKey = (k) => (k.slice(0, PREFIX.length) === PREFIX ? k.slice(PREFIX.length) : k);

/*
 * The contract, stringified ONCE per shape rather than per read.
 *
 * The controller re-reads both keys on every reload, and TB3PO_PARAMS is ~2 KB
 * -- cheap on the wire and not cheap at 44 Hz on this CPU. The hierarchy is
 * rebuilt only when a 303 appears or leaves, which is the only thing that
 * changes its shape.
 */
const CHAIN_PARAMS_JSON = JSON.stringify(TB3PO_PARAMS);
let hierarchyJson = null;
let hierarchyHas303 = null;
function hierarchyJsonFor(has303) {
    if (hierarchyHas303 !== has303) {
        hierarchyHas303 = has303;
        hierarchyJson = JSON.stringify(hierarchyFor({ has303: has303 }));
    }
    return hierarchyJson;
}

const ctl = createController({
    getParam: (fullKey) => uiGetParam(bareKey(fullKey)),
    setParam: (fullKey, val) => { uiSetParam(bareKey(fullKey), val); },
    /* TB-3PO has no screen-reader path of its own yet; announcing into nothing
     * is better than a second announcer disagreeing with the host's. */
    announce: () => {},
});
ctl.setLayout(LAYOUT_MOVY);

/*
 * WHICH KNOBS ARE LIVE ON THE PAGE THE USER IS LOOKING AT.
 *
 * The controller is parked on the Pattern page while PERFORM is shown, so its
 * knobs 5-8 have real keys -- but PERFORM draws one row and only four of its
 * knobs do anything. Gating here rather than inside the controller keeps the
 * controller's page honest: the page really does have eight keys, TB-3PO is
 * simply not showing four of them.
 */
function knobLive(slot) {
    const kind = curPage().kind;
    if (kind === "knobs") return true;
    if (kind === "perform") return slot < PERFORM_KNOBS;
    return false;
}

/*
 * ONE DETENT PER UNIT OF DELTA, and this is not a nicety.
 *
 * `applyInput` calls `onKnobTurn` with a DIRECTION and moves one detent, which
 * is right for the shadow UI: the surface hands it one CC per physical detent.
 * An OVERTAKE module is fed by a different path -- shadow_ui.js batches the
 * encoder ticks of a frame and sends the accumulated COUNT as the CC value
 * (see the header note) -- so collapsing to +-1 throws the rest of a fast flick
 * away and the knob moves at the speed of the slowest possible turn whatever
 * you do with it. movy hit exactly this and reported it as "knobs move very
 * very slowly like shift is held"; the old TB-3PO dispatch avoided it by
 * passing the count straight into knob_engine.
 *
 * Capped because the delta arrives as a signed byte: a garbled CC should cost
 * a bounded number of steps, not 63 of them.
 */
function knobTurn(intent) {
    const n = Math.min(Math.abs(intent.direction) | 0, 32) || 1;
    const t = Date.now();
    const one = { type: "knob", slot: intent.slot,
                  direction: intent.direction > 0 ? 1 : -1, fine: intent.fine };
    for (let i = 0; i < n; i++) applyInput(ctl, one, { nowMs: t });
}

/*
 * The held knob AS THE SCREEN SHOULD SHOW IT.
 *
 * `state.touched` is the controller's, and it follows a TURN as well as a
 * touch (a knob can be moved without the capacitive pad ever registering).
 * Clamped by the same rule as knobLive, so PERFORM cannot report a hold on a
 * knob it does not draw and Pads/Keys cannot report one at all.
 */
function heldSlot() {
    const t = ctl.state.touched;
    if (t < 0) return -1;
    return knobLive(t) ? t : -1;
}

/*
 * ONE FUNCTION, because there are now two page indices.
 *
 * TB-3PO owns the outer 0..5 and the controller owns its own 0..2, and a
 * mapping repeated at each call site is a mapping that ends up applied at four
 * of the five. Every path that moves the outer index -- jog, step buttons,
 * track buttons, a 303 appearing or leaving -- ends here.
 */
function syncController() {
    const r = pages();
    const target = controllerPageFor(r, clampPageIndex(ui.activeSlot));
    /*
     * `remember: false` -- GO EXACTLY HERE.
     *
     * `goToPage` otherwise runs the target through the controller's SECTION
     * MEMORY, which can land on a different page of the same level than the one
     * asked for. That is right for its own jog, where the user is navigating
     * the controller's page set; it is wrong here, where TB-3PO's outer index
     * has already decided and the two must stay one-to-one. Harmless today
     * (each level plans exactly one page, so the memory returns the index it
     * was given) and a silent index drift the moment a level plans two.
     */
    if (target >= 0 && target !== ctl.pageIndex) ctl.goToPage(target, { remember: false });
}

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
        /* A bank recall brings a whole pattern back, LENGTH included -- an edit
         * the grid did not make. See noteExternalChange. */
        const wasLength = cur().length;
        parsePattern(getDspParam(slotKey("pattern")));
        if (cur().length !== wasLength) noteExternalChange("length");
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
         * changes the page set's LENGTH -- and every index behind the 303 page
         * then names a different page. Resolve by NAME across the change
         * rather than clamping an index that has silently moved. */
        const wasNames = [pages()[clampPageIndex(0)].name, pages()[clampPageIndex(1)].name];
        cc303SlotIdx = find303Slot();
        const prev = has303Slot;
        has303Slot = cc303SlotIdx >= 0;
        if (prev !== has303Slot) {
            const r = pages();
            for (let sIdx = 0; sIdx < 2; sIdx++) {
                let found = r.findIndex((pg) => pg.name === wasNames[sIdx]);
                if (found < 0) found = r.findIndex((pg) => pg.name === "Pattern");
                pageIndex[sIdx] = found < 0 ? 0 : found;
            }
            /* The 303 page is a LEVEL in the contract TB-3PO publishes to
             * itself, so its arrival or departure changes the hierarchy's
             * shape. This is the only thing that does, which is why the
             * controller is re-planned here rather than probed every tick --
             * `reloadIfChanged` re-reads and re-plans, and planPages is not
             * free at 44 Hz. */
            ctl.reloadIfChanged();
            syncController();
            if (prev && wasNames[ui.activeSlot] === "303") {
                showOverlay("303 unloaded", "page removed");
            }
        }
    }
    pollTick++;
}

// -------- The controller's parameter I/O ----------

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/*
 * The integer inside an option's text -- 16 from "16 Steps", 10 from "Ch 10".
 *
 * `length` and `channel` wire their option TEXT rather than an index, because
 * an option that reads as a bare decimal shadows its own index in the shared
 * write path (see the note in params.mjs). This is the one place that text is
 * turned back into the quantity the DSP wants.
 */
function firstInt(v) {
    const m = String(v).match(/-?\d+/);
    return m ? parseInt(m[0], 10) : NaN;
}

/*
 * WHAT A KEY READS.
 *
 * Every value is a string, because that is what a get_param answers with and
 * the controller parses accordingly. Two conventions are load-bearing and both
 * are declared rather than converted here:
 *
 *   `length` and `channel` are enums with `options_as_string`, so their wire
 *   value IS the option text -- a step COUNT and a channel NUMBER, exactly
 *   what the DSP and the Ch-/Ch+ pads speak. There is no index projection
 *   anywhere any more; see the note in params.mjs for why an index would be
 *   actively wrong for these two.
 *
 *   `root`, `scale` and `direction` are index-addressed enums whose options
 *   are words, so the index is the wire value and the DSP already speaks it.
 *
 * An unknown key answers "" -- served, nothing to say -- and never null, which
 * on this channel would mean "the read did not complete" and is a thing that
 * cannot happen when the answer is a local field.
 */
function uiGetParam(key) {
    if (key === "ui_hierarchy") return hierarchyJsonFor(has303Slot);
    if (key === "chain_params") return CHAIN_PARAMS_JSON;
    const slot = cur();
    switch (key) {
        case "density": return String(slot.density);
        case "accent":  return String(slot.accent);
        case "slide":   return String(slot.slide);
        case "gate":    return String(slot.gate);
        case "root":    return String(slot.root | 0);
        case "scale":   return String(slot.scale | 0);
        /* The option TEXT, which is this enum's wire value. */
        case "length":  return (slot.length | 0) + " Steps";
        case "octaves": return String(slot.octaves | 0);
        case "channel": return "Ch " + (slot.channel | 0);
        case "direction": return String(slot.direction | 0);
        case "transpose": return String(slot.transpose | 0);
        /* A READOUT. 1-based, because the pads and the overlays count banks
         * from 1 and the cell must agree with them. */
        case "current_bank": return String((slot.currentBank | 0) + 1);
        default: break;
    }
    const idx = cc303Index(key);
    if (idx >= 0) return String(slot.cc303[idx] | 0);
    return "";
}

/* Keys whose value only takes effect on the NEXT generation. */
const STALE_KEYS = new Set(["density", "accent", "slide", "octaves"]);

/*
 * WHAT A KEY WRITES.
 *
 * The inverse of uiGetParam and the ONLY write path the grid has. The knob
 * engine, the throttle, the enum wire format and the option picker all sit on
 * the far side of it, so nothing here has to know which gesture produced the
 * value.
 */
function uiSetParam(key, val) {
    const slot = cur();
    const idx = cc303Index(key);
    if (idx >= 0) { write303(idx, Math.round(Number(val))); return; }
    const num = Number(val);
    switch (key) {
        case "density": case "accent": case "slide": case "gate":
            if (!isFinite(num)) return;
            slot[key] = num;
            setDspParam(slotKey(key), num.toFixed(3));
            break;
        case "root": case "scale": case "direction": case "octaves":
            if (!isFinite(num)) return;
            slot[key] = Math.round(num);
            setDspParam(slotKey(key), String(slot[key]));
            break;
        case "transpose":
            if (!isFinite(num)) return;
            slot.transpose = clamp(Math.round(num), -48, 48);
            setDspParam(slotKey("transpose"), String(slot.transpose));
            break;
        case "length": {
            /* The step COUNT out of "16 Steps" -- see uiGetParam and firstInt. */
            const n = firstInt(val);
            if (!isFinite(n) || n <= 0) return;
            slot.length = n;
            setDspParam(slotKey("length"), String(slot.length));
            clampStepView();
            break;
        }
        case "channel": {
            /* The channel NUMBER out of "Ch 10". */
            const n = firstInt(val);
            if (!isFinite(n)) return;
            slot.channel = clamp(n, 1, 16);
            setDspParam(slotKey("channel"), String(slot.channel));
            break;
        }
        /* current_bank is `access: "read"`; isTurnable refuses it and the
         * picker refuses it, so nothing can reach here with it. */
        default: return;
    }
    if (STALE_KEYS.has(key)) patternStale = true;
}

/*
 * A VALUE THE GRID DID NOT WRITE MUST BE TOLD TO THE GRID.
 *
 * TB-3PO edits several params from places that are not a knob: the Ch-/Ch+ and
 * DIR action pads, the hardware +/- buttons, and a bank recall that brings a
 * whole pattern (and its LENGTH) back from the DSP. The controller holds two
 * things per key and the read cursor only refreshes one of them:
 *
 *   `values`      the cached reading -- refreshed by the cursor within ~9
 *                 ticks, so a stale cell repairs itself
 *   `knobStates`  the knob engine's running value -- seeded ONCE, on the first
 *                 turn of that key, and never re-synced afterwards
 *
 * So leaving it alone is not "a cell that lags"; it is a knob that SNAPS THE
 * VALUE BACK on the first detent after the pad. Dropping the engine state
 * re-seeds it from the fresh reading.
 */
function noteExternalChange(key) {
    const st = ctl.state;
    st.values[key] = uiGetParam(key);
    delete st.knobStates[key];
}

/*
 * EVERY value at once, for the changes that are not about one key.
 *
 * Switching slot A/B replaces the whole parameter set -- two independent
 * sequencers on two channels -- and pulling the 303's live values in does the
 * same for that page. `dspValues` was recomputed on every draw, so this was
 * free before; the controller CACHES, so it has to be told. Cheap because
 * every read is a local field: ~20 of them, once, on a gesture.
 */
function syncAllValues() {
    for (const p of ctl.pages) {
        for (const k of (p.keys || [])) if (k) noteExternalChange(k);
    }
}

/* One press, one channel. The knob engine is the controller's now, and an
 * action pad is not a knob -- it has no accumulation to carry. */
function nudgeChannel(d) {
    const slot = cur();
    const v = clamp((slot.channel | 0) + d, 1, 16);
    if (v === slot.channel) return;
    slot.channel = v;
    setDspParam(slotKey("channel"), String(v));
    noteExternalChange("channel");
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
    /*
     * CAPPED, not wrapped.
     *
     * Wrapping means the ends are invisible: you cannot feel where the page
     * set stops, so you have to read the bank bar to know where you are.
     * Capping gives the gesture a floor and a ceiling to run into.
     *
     * It is also what the rest of the device does -- page_nav.mjs `step()` is
     * clampIndex(clampIndex(index) + delta), no modulo -- so wrapping here was
     * TB-3PO disagreeing with every other Schwung screen, not a house style.
     */
    const n = pages().length;
    const step = delta > 0 ? 1 : -1;
    const next = clampPageIndex(ui.activeSlot) + step;
    pageIndex[ui.activeSlot] = next < 0 ? 0 : (next > n - 1 ? n - 1 : next);
    /*
     * THE JOG IS NOT ROUTED THROUGH `applyInput`, deliberately.
     *
     * Its `page` intent calls `controller.onJog`, which WRAPS within the
     * controller's three pages -- so it would both move the wrong index and
     * disagree with the cap above at the ends. TB-3PO owns the outer index;
     * the controller is told where to be.
     */
    syncController();
}

/*
 * WHICH KEY A PHYSICAL KNOB EDITS is the CONTROLLER'S answer now.
 *
 * This was a hand-rolled table plus a page-kind switch plus a readout guard
 * plus a per-type adjust helper -- four things `page_controller` already does,
 * kept in step by hand. `ctl.keyAt(slot)` is the whole of it, and it cannot
 * disagree with the cell that was drawn because the cell was drawn from the
 * same array.
 *
 * PERFORM still inherits Pattern's ROW 0 -- the same four in the same
 * positions, or knob 4 would mean Octaves on one page and Gate on another --
 * and it does so by the controller being PARKED on the Pattern page while
 * PERFORM is shown (see syncController and controllerPageFor). Knobs 5-8 are
 * inert there, which is knobLive's job.
 *
 * Exported for the same reason it always was: the smoke test asserts which
 * knob drives which key, and that is the redesign's load-bearing claim.
 */
export function keyForKnob(idx) {
    if (!(idx >= 0 && idx < 8)) return null;
    if (!knobLive(idx)) return null;
    return ctl.keyAt(idx) || null;
}

/* ===================== THE ENUM OPTION PICKER =====================
 *
 * Touch a knob, click the jog: the cell under your hand opens as a list. The
 * GESTURE and the DECISION are the controller's -- `applyInput` routes the
 * click, `onClick` decides the cell is a door and `takePending` hands over the
 * options -- but the LIST ITSELF is drawn here, because the controller does
 * not draw one: it hands the host an intent and expects the host to own the
 * screen. Hence drawEnumList rather than a local drawMenuList call: "a second
 * list widget is how Master FX and the chain editor drifted apart".
 *
 * WHAT IS DIFFERENT HERE, and it is not a design choice: THERE IS NO CANCEL.
 *
 * shadow_ui.js claims a plain Back press for every `suspend_keeps_js` overtake
 * module (this one) and turns it into suspendOvertakeMode() BEFORE the forward
 * to onMidiMessageInternal -- the module only ever sees the RELEASE edge, which
 * is why the CC_BACK case below has always been a comment and a `return`. So a
 * Back that cancelled the picker would be a Back that also parked the tool, and
 * inventing some other cancel key would be a gesture fighting the host for no
 * gain. A second jog click commits; nothing cancels. The footer says exactly
 * that (JOG SEL / CLK SET) and never advertises a BACK EXIT it cannot honour.
 *
 * Nothing is written while you scroll -- the commit is one commitEnum at
 * close -- so the `*` mark still means "the value that is live", and moving off
 * it still reads as having moved off it.
 */
let picker = null;

function pickerIsOpen() { return picker !== null; }

/*
 * OPEN THE PICKER FROM THE CONTROLLER'S OWN INTENT.
 *
 * `applyInput` routes a click on a held cell to `controller.onClick`, which
 * decides whether that cell is a door -- the SAME `divable` predicate the
 * footer hint and the corner brackets use -- and, for an enum, hands back the
 * option list and the live index in `takePending()`. There is no second
 * "is it an enum, does it have options, where is it now" test here any more;
 * re-deriving that is exactly how a footer promising CLK OPEN and a click that
 * opens nothing come apart.
 *
 * A non-enum door (a filepath, a canvas) would arrive with no `options`. TB-3PO
 * declares none and has no editor to open one in, so it is refused rather than
 * showing an empty list you cannot back out of.
 */
function openPickerFrom(pending) {
    if (!pending || pending.action !== "open") return false;
    const options = Array.isArray(pending.options) ? pending.options.map(String) : [];
    if (options.length === 0) return false;
    const meta = pending.meta || {};
    const live = clamp(pending.index | 0, 0, options.length - 1);
    picker = {
        key: pending.key,
        title: meta.label || meta.name || pending.key,
        options: options,
        index: live,
        /* The value that is LIVE, i.e. what the `*` marks. */
        openIndex: live,
    };
    return true;
}

/* ONE DETENT, ONE ROW. The jog delta arriving here is already a physical
 * detent count (shadow_ui accumulates one CC per detent), so 1:1 is the whole
 * rule -- no divisor, no acceleration. These lists are 4 and 16 long and
 * overshooting one is worse than arriving slowly. */
function pickerJog(delta) {
    if (!picker || delta === 0) return;
    picker.index = clamp(picker.index + delta, 0, picker.options.length - 1);
}

/*
 * The commit is `ctl.commitEnum`, not a local write.
 *
 * It puts the value on the wire through `enumWireValue`, which respects
 * whichever convention the param declared -- and `length` and `channel` are
 * `options_as_string`, so an index write here would be silently wrong for
 * thirteen of the sixteen channels. It also drops the knob state for that key,
 * so the first detent after the picker steps from where you left it rather
 * than snapping back.
 */
function closePicker(commit) {
    if (!picker) return;
    const p = picker;
    picker = null;
    if (commit) ctl.commitEnum(p.key, p.index);
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
    /* Eight values replaced behind the grid's back -- see noteExternalChange. */
    for (const k of CC_303_PARAM_KEYS) noteExternalChange(CC_303_PREFIX + k);
}

/*
 * "303.cutoff" -> 0, or -1 for a key that is not the 303 page's.
 *
 * The prefix is stripped by looking the suffix up in CC_303_PARAM_KEYS, which
 * is also the array the CC numbers are indexed by -- so the declared key, the
 * plugin's real param name and the CC it rides on cannot drift apart. The
 * prefix exists because "accent" is already this sequencer's accent
 * PROBABILITY; see the note in params.mjs.
 */
const CC_303_PREFIX = "303.";
function cc303Index(key) {
    if (key.slice(0, CC_303_PREFIX.length) !== CC_303_PREFIX) return -1;
    return CC_303_PARAM_KEYS.indexOf(key.slice(CC_303_PREFIX.length));
}

/*
 * A 303 param is written as a CC to ANOTHER chain slot, not as a set_param.
 *
 * This used to take a knob index and a DELTA and run its own knob_engine. It
 * takes a VALUE now: the controller owns the engine, so the accumulation, the
 * fine mode and the throttle all happen once, in the one place, for every
 * param TB-3PO has -- and this is left with the part that is genuinely
 * different, which is that the destination is a MIDI CC.
 */
function write303(idx, value) {
    const cc = CC_303[idx];
    if (cc === undefined || !isFinite(value)) return;
    const slot = cur();
    const next = clamp(Math.round(value), 0, 127);
    if (next === (slot.cc303[idx] | 0)) return;
    slot.cc303[idx] = next;
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
 * absent from the pages, so T2/T4 land on Pattern -- there is nothing to refuse
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
    const slotChanged = ui.activeSlot !== slotIdx;
    ui.activeSlot = slotIdx;
    setDspParam("active_slot", String(slotIdx));
    /* A different slot is a different set of values behind the same keys. */
    if (slotChanged) syncAllValues();
    const r = pages();
    let found = r.findIndex((pg) => pg.name === pageName);
    if (found < 0) found = r.findIndex((pg) => pg.name === "Pattern");
    pageIndex[slotIdx] = found < 0 ? 0 : found;
    if (pageName === "303" && has303Slot) sync303FromPlugin();
    syncController();
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
            noteExternalChange("current_bank");
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
                noteExternalChange("current_bank");
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
                noteExternalChange("direction");
                showOverlay("Direction", DIRECTIONS[slot.direction] || "?");
                break;
            case 3:
                nudgeChannel(-1);
                showOverlay("Channel", String(cur().channel));
                break;
            case 4:
                nudgeChannel(+1);
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

    // Step buttons — page selector, one per page in the CURRENT pages (five or
    // six, depending on whether a 303 is reachable). Available = white,
    // current = green.
    const pageCount = pages().length;
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
    /*
     * The picker OWNS the screen -- not an overlay over the page, because the
     * page's own knob row is exactly what it has replaced. drawOverlay is
     * skipped for the same reason knob turns stopped raising one: a box on top
     * of the thing you are reading.
     */
    if (picker) {
        drawEnumList(ctx, {
            title: picker.title,
            /* SELECT, the word the shared picker and the module picker both put
             * there: the grammar of the band says "a list, pick one" before you
             * have read the title. */
            headerRight: "SELECT",
            options: picker.options,
            index: picker.index,
            markIndex: picker.openIndex,
            /* No BACK EXIT pair -- see the picker's own note. The click is the
             * only way out and the footer must not promise a second one. */
            footer: [["JOG", "SEL"], ["CLK", "SET"]],
        });
        return;
    }
    const slot = cur();
    const r = pages();
    const idx = clampPageIndex(ui.activeSlot);
    drawPage(fb, ctx, {
        /* DIVABILITY IS A FOOTER FACT. The cell wears no mark for it -- 953 of
         * the fleet's 967 divable cells wear none -- so the only honest place
         * to say the click will open something is the footer, and only while
         * the knob that would open it is under a hand. */
        slotLabel: "Slot " + (ui.activeSlot === 0 ? "A" : "B"),
        bpm: ui.bpm,
        pages: r,
        pageIndex: idx,
        steps: slot.steps,
        position: slot.position,
        stepView: slot.stepView,
        shiftHeld: shiftHeld,
        /* A knob with no key on this page has no cell to strip, and Setup's
         * knobs 5-8 have no key at all -- so the touch is reported only where
         * there is something for it to highlight. See heldSlot(). */
        touched: heldSlot(),
        /* The controller holds the values, the metadata, the page and the
         * widgets. Nothing about the grid is passed alongside it any more --
         * a second copy of any of those is what this redesign removed. */
        ctl: ctl
    });
    // Overlay last so it sits on top of whatever the page drew.
    drawOverlay();
}

// -------- Lifecycle ----------

globalThis.init = function() {
    console.log("[tb3po] ui init");
    /*
     * Plan the pages BEFORE the first frame.
     *
     * `load` reads the contract, plans, builds the meta index and warms the
     * landing page's values, all synchronously -- which it can, because every
     * read is a local field. Skipping it would draw one frame of a component
     * with no pages, and `load` is also where the 303 scan's answer first
     * reaches the hierarchy.
     */
    cc303SlotIdx = find303Slot();
    has303Slot = cc303SlotIdx >= 0;
    ctl.load({ slot: 0, component: "synth" });
    syncController();
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
    /*
     * One stop of the controller's read cursor per frame.
     *
     * It is the shared rotation and it is deliberately not unrolled here. On
     * hardware the stagger exists because a param read is ~2.8 ms of IPC
     * against a 1.68 ms whole-page render; here a read is a field access, so
     * the only thing the rotation costs is up to ~9 frames of lag on a value
     * something OTHER than the grid changed -- and every such value is either
     * pushed in by noteExternalChange or is the Bank readout, which already
     * has an overlay saying what it just did.
     *
     * `reloadIfChanged` is NOT called per tick: planPages is not free, and the
     * only thing that changes this contract's shape is a 303 arriving or
     * leaving, which pollDsp already notices.
     */
    ctl.tick();
    refreshLeds();
    draw();
};

globalThis.onMidiMessageInternal = function(data) {
    if (!data) return;
    const status = data[0] | 0;
    const d1 = data[1] | 0;
    const d2 = data[2] | 0;
    const type = status & 0xF0;

    /*
     * Capacitive touch: notes 0-7 = knob touches, 8 = master touch, 9 = main jog.
     *
     * Notes 0-7 go to the CONTROLLER, always -- even on Pads and Keys, where
     * no knob does anything. A touch is an edge pair, and gating the release
     * on the page you happen to be looking at is how a knob gets left stuck as
     * "held" after a page change. What the page gates is the DRAW (heldSlot)
     * and the TURN (knobLive), neither of which latches.
     *
     * 8 and 9 are the master-volume and jog pads and belong to nobody here.
     */
    if ((type === 0x90 || type === 0x80) && d1 < 10) {
        if (d1 < 8) {
            const t = decodeInput(data, { shift: shiftHeld });
            if (t) applyInput(ctl, t, { nowMs: Date.now() });
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

    /*
     * THE PICKER OWNS THE SURFACE, and this must sit ABOVE everything it
     * suppresses.
     *
     * The draw path puts the picker last (it returns before drawPage); the
     * input path has to feed it first, because every handler below is an
     * early-out that would consume the event before this test ran. A pad press
     * or a knob turn landing on the page UNDER the picker is the same class of
     * bug as a click that acts on a cell the footer was not describing.
     *
     * Shift is tracked above this, deliberately: it is state, not an action,
     * and leaving it stale across a picker would strand the pad rows in save
     * mode.
     */
    if (pickerIsOpen()) {
        if (type === 0xB0 && d1 === 14) { pickerJog(decodeDelta(d2)); return; }
        if (type === 0xB0 && d1 === CC_JOG_CLICK && d2 > 0) { closePicker(true); return; }
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
        noteExternalChange("transpose");
        showOverlay("Transpose", (slot.transpose / 12) + " oct");
        return;
    }
    if (type === 0xB0 && d1 === CC_UP && d2 > 0) {
        const slot = cur();
        slot.transpose = Math.min( 48, (slot.transpose | 0) + 12);
        setDspParam(slotKey("transpose"), String(slot.transpose));
        noteExternalChange("transpose");
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

    /*
     * Knob deltas arrive as synthetic CC messages (CC 71-78).
     *
     * `decodeInput` turns one into a `knob` intent and `applyInput` hands it to
     * the controller, which owns the knob engine, the readout guard, the enum
     * wire format, the write throttle and the enum peek. The four-line
     * dispatch that used to live here was a re-derivation of all of it.
     *
     * SHIFT IS NOT PASSED as `fine`. Shift on this surface already means
     * "these pad rows are save targets" and holding it is a bank gesture, not
     * a precision gesture -- see refreshLeds' shiftHeld branch.
     */
    if (type === 0xB0 && d1 >= CC_KNOB_BASE && d1 < CC_KNOB_BASE + 8) {
        if (!knobLive(d1 - CC_KNOB_BASE)) return;
        const intent = decodeInput(data, {});
        if (intent) knobTurn(intent);
        return;
    }

    // Jog wheel (CC 14) — turns PAGES, on every page.
    if (type === 0xB0 && d1 === 14) {
        handleJogTurn(decodeDelta(d2));
        return;
    }

    /*
     * Jog click — dive into the cell under your hand, if it has anything to
     * dive into. Nothing held, or a cell that is not divable, and the click
     * does nothing at all: it is the shared UI's gesture, so it must not
     * acquire a second meaning here.
     *
     * SHIFT+CLICK IS NOT ROUTED. `applyInput` sends it to `openPicker`, the
     * controller's SECTION picker -- a list of the controller's three pages
     * under a bank bar showing six, i.e. a second navigation surface
     * disagreeing with the one on screen. TB-3PO already has page jumps on the
     * track buttons and the step buttons.
     */
    if (type === 0xB0 && d1 === CC_JOG_CLICK && d2 > 0) {
        if (shiftHeld) return;
        if (heldSlot() < 0) return;
        const intent = decodeInput(data, {});
        if (!intent) return;
        openPickerFrom(applyInput(ctl, intent, { nowMs: Date.now() }));
        return;
    }

    // Step buttons (notes 16-31) — page selector, clamped to the pages, which
    // is five or six long depending on whether a 303 is reachable.
    if (type === 0x90 && d1 >= NOTE_STEP_BASE && d1 < NOTE_STEP_BASE + NUM_STEP_BUTTONS && d2 > 0) {
        const stepIdx = d1 - NOTE_STEP_BASE;
        if (stepIdx >= 0 && stepIdx < pages().length) {
            pageIndex[ui.activeSlot] = stepIdx;
            syncController();
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
    ui, pageIndex, curPage, ctl,
    /*
     * Show an outer page. THE ONLY way a test may move the index, because
     * moving it is two things -- the outer index and the controller's -- and
     * `syncController` is the one function that does both. A test poking
     * `pageIndex` directly would leave the controller on the previous page and
     * then assert against whichever one it happened to be looking at.
     */
    showPage: (i) => { pageIndex[ui.activeSlot] = i; syncController(); },
    /* The controller's parameter I/O, which is the whole of TB-3PO's side of
     * the contract: what a key reads and what a write to it does. */
    getParam: uiGetParam, setParam: uiSetParam, noteExternalChange,
    /* The picker is module-private state driven entirely through
     * onMidiMessageInternal; the tests drive the REAL gesture and read the
     * result here rather than being handed an opener of their own. */
    picker: () => picker,
    metaFor: (key) => ctl.metaIndex.getOrGuess(key),
};
