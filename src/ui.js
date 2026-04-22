// TB-3PO UI — pad/knob/display bridge. All sequencing lives in dsp.so.

import {
    showOverlay, tickOverlay, drawOverlay, hideOverlay
} from '/data/UserData/schwung/shared/menu_layout.mjs';
import {
    setLED as sharedSetLED, setButtonLED as sharedSetButtonLED
} from '/data/UserData/schwung/shared/input_filter.mjs';
import { createValue, createEnum } from '/data/UserData/schwung/shared/menu_items.mjs';

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
const CC_UNDO = 56;             // Move's Undo button
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
const PAGE_CHANNEL = 3;
const PAGE_HELP = 4;
const NUM_PAGES = 5;
const PAGE_NAMES_3PO = ["PERFORM", "MUTATION", "SCALE", "CHANNEL", "HELP"];
const PAGE_NAMES_303 = ["PERFORM", "303 Control 1", "303 Control 2", "CHANNEL", "HELP"];
function pageName(idx) {
    return (cur().mode === MODE_303 ? PAGE_NAMES_303 : PAGE_NAMES_3PO)[idx] || "?";
}

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
        mode: MODE_3PO,
        stepView: 0,
        menuState: {
            [PAGE_MUTATION]: { selectedIndex: 0, editing: false },
            [PAGE_SCALE]:    { selectedIndex: 0, editing: false },
            [PAGE_CHANNEL]:  { selectedIndex: 0, editing: false }
        }
    }, defaults || {});
}

let ui = {
    activeSlot: 0,
    slots: [makeSlot()],
    bpm: 120,
    running: 1,
    syncSource: "INT"
};

function cur() { return ui.slots[ui.activeSlot]; }

let pollTick = 0;
let shiftHeld = false;
let currentPage = PAGE_PERFORM;

function stepPageCount() { return Math.max(1, Math.ceil(cur().length / 16)); }
function clampStepView()  { const m = stepPageCount() - 1; if (cur().stepView > m) cur().stepView = m; if (cur().stepView < 0) cur().stepView = 0; }

// -------- DSP bridge ----------

// Per-slot DSP params are namespaced with "a." / "b." prefixes so one DSP
// instance can host two independent slots (Task 3). For Task 2 only "a."
// is produced — the DSP strips the prefix at the dispatch entry. Globals
// (bpm, running, sync_source, etc.) stay bare.
function slotKey(k) { return (ui.activeSlot === 0 ? "a." : "b.") + k; }

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
    if (isFinite(len) && len > 0) cur().length = len;
    const stepsCsv = parts[1].split(",");
    const slot = cur();
    for (let i = 0; i < stepsCsv.length && i < slot.steps.length; i++) {
        slot.steps[i] = parseInt(stepsCsv[i], 10) | 0;
    }
}

function pollDsp() {
    const pos = getDspParam(slotKey("position"));
    if (pos !== null && pos !== "") cur().position = parseInt(pos, 10) | 0;
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
    }

    // Re-scan for a 303 slot every ~1.4 sec so Track 2 / 303-mode UX reflects
    // reality: hidden when no 303 is loaded, visible when one is loaded later.
    if ((pollTick % 60) === 0) {
        cc303SlotIdx = find303Slot();
        const prev = has303Slot;
        has303Slot = cc303SlotIdx >= 0;
        if (prev && !has303Slot && cur().mode === MODE_303) {
            cur().mode = MODE_3PO;
            showOverlay("303 unloaded", "knob mode → 3PO");
        }
    }
    pollTick++;
}

// -------- Knob handling ----------

// Shadow UI batches encoder ticks per frame (~22ms) and encodes the
// accumulated count as the CC value (CW = 1..63, CCW = 65..127). That
// accumulated count is already speed-proportional — turning faster
// delivers a bigger count per frame. So we use the raw signed count
// directly and scale it by a per-context gain constant below; running
// it through decodeAcceleratedDelta() on top double-counted speed and
// felt twitchy.
function decodeDelta(value) {
    if (value === 0 || value === 64) return 0;
    if (value <= 63) return value;
    return -(128 - value);
}

// Global knob-gain factors — raise to sweep faster, lower for fine.
// 3PO param knobs (density/accent/slide/octaves on page, root/scale/
// length/gate on scale page). 1.0 = each encoder tick ≈ one unit.
const KNOB_GAIN_3PO = 1.0;
// 303 mode: each encoder tick nudges the CC by this many units. 303
// params read 0–127 so we want a slightly coarser sweep than 3PO.
const KNOB_GAIN_303 = 1.5;
// Jog while in value-edit mode (MUTATION/SCALE/CHANNEL pages).
const JOG_EDIT_GAIN = 1.0;

function scaleDelta(raw, gain) {
    if (raw === 0 || gain === 0) return 0;
    const scaled = raw * gain;
    // Preserve at least one unit of motion so a slow turn still registers.
    if (scaled > 0 && scaled < 1) return 1;
    if (scaled < 0 && scaled > -1) return -1;
    return Math.round(scaled);
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function adjustFloat(key, uiKey, delta, step, lo, hi) {
    const slot = cur();
    const next = clamp(slot[uiKey] + delta * step, lo, hi);
    if (next !== slot[uiKey]) {
        slot[uiKey] = next;
        setDspParam(slotKey(key), next.toFixed(3));
    }
}

// Detent-step accumulator: small, discrete-set params (enums, short int
// ranges) should take several encoder clicks to advance one step so
// they don't whip through values. Drain `delta` into an accumulator
// and return whole steps when the threshold is crossed.
const DETENTS_PER_STEP = 4;
const detentAccum = {};  // keyed by uiKey

function consumeDetents(uiKey, delta) {
    if (delta === 0) return 0;
    const acc = (detentAccum[uiKey] || 0) + delta;
    const steps = (acc > 0)
        ? Math.floor(acc / DETENTS_PER_STEP)
        : -Math.floor(-acc / DETENTS_PER_STEP);
    detentAccum[uiKey] = acc - steps * DETENTS_PER_STEP;
    return steps;
}

function resetDetents(uiKey) {
    detentAccum[uiKey] = 0;
}

function adjustInt(key, uiKey, delta, lo, hi) {
    const steps = consumeDetents(uiKey, delta);
    if (steps === 0) return;
    const slot = cur();
    const next = clamp((slot[uiKey] | 0) + steps, lo, hi);
    if (next !== slot[uiKey]) {
        slot[uiKey] = next;
        setDspParam(slotKey(key), String(next));
    }
}

function adjustEnum(key, uiKey, delta, count) {
    const steps = consumeDetents(uiKey, delta);
    if (steps === 0) return;
    const slot = cur();
    const next = ((slot[uiKey] | 0) + steps + count * 100) % count;
    if (next !== slot[uiKey]) {
        slot[uiKey] = next;
        setDspParam(slotKey(key), String(next));
    }
}

function adjustLength(delta) {
    const steps = consumeDetents("length", delta);
    if (steps === 0) return;
    const slot = cur();
    const idx = LENGTHS.indexOf(slot.length);
    const curIdx = idx < 0 ? 1 : idx;
    const next = LENGTHS[clamp(curIdx + steps, 0, LENGTHS.length - 1)];
    if (next !== slot.length) {
        slot.length = next;
        setDspParam(slotKey("length"), String(next));
    }
}

let patternStale = false;  // true when prob-knobs have changed since last generate

// -------- Jog-menu items per page ----------
// Each page that's editable declares an items() builder. The items are
// rebuilt per access so they read the live ui state via their getters.

function scalePageItems() {
    return [
        createEnum("K5: Root", {
            get: () => cur().root,
            set: (v) => { cur().root = v; setDspParam(slotKey("root"), String(v)); },
            options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            format: (v) => ROOT_NAMES[v] || "?"
        }),
        createEnum("K6: Scale", {
            get: () => cur().scale,
            set: (v) => { cur().scale = v; setDspParam(slotKey("scale"), String(v)); },
            options: SCALE_NAMES.map((_, i) => i),
            format: (v) => SCALE_NAMES[v] || "?"
        }),
        createEnum("K7: Length", {
            get: () => cur().length,
            set: (v) => { cur().length = v; setDspParam(slotKey("length"), String(v)); },
            options: LENGTHS
        }),
        createValue("K8: Gate", {
            get: () => Math.round(cur().gate * 100),
            set: (v) => { cur().gate = v / 100; setDspParam(slotKey("gate"), (v / 100).toFixed(3)); },
            min: 10, max: 100,
            format: (v) => v + "%"
        })
    ];
}

function mutationPageItems() {
    const setStale = () => { patternStale = true; };
    return [
        createValue("K1: Density", {
            get: () => Math.round(cur().density * 100),
            set: (v) => { cur().density = v / 100; setDspParam(slotKey("density"), (v / 100).toFixed(3)); setStale(); },
            min: 0, max: 100, format: (v) => v + "%"
        }),
        createValue("K2: Accent", {
            get: () => Math.round(cur().accent * 100),
            set: (v) => { cur().accent = v / 100; setDspParam(slotKey("accent"), (v / 100).toFixed(3)); setStale(); },
            min: 0, max: 100, format: (v) => v + "%"
        }),
        createValue("K3: Slide", {
            get: () => Math.round(cur().slide * 100),
            set: (v) => { cur().slide = v / 100; setDspParam(slotKey("slide"), (v / 100).toFixed(3)); setStale(); },
            min: 0, max: 100, format: (v) => v + "%"
        }),
        createValue("K4: Octaves", {
            get: () => cur().octaves,
            set: (v) => { cur().octaves = v; setDspParam(slotKey("octaves"), String(v)); setStale(); },
            min: 1, max: 3
        })
    ];
}

function channelPageItems() {
    return [
        createValue("MIDI Ch", {
            get: () => cur().channel,
            set: (v) => { cur().channel = v; setDspParam(slotKey("channel"), String(v)); },
            min: 1, max: 16
        })
    ];
}

function currentPageItems() {
    if (currentPage === PAGE_SCALE)    return scalePageItems();
    if (currentPage === PAGE_MUTATION) return mutationPageItems();
    if (currentPage === PAGE_CHANNEL)  return channelPageItems();
    return null;
}

function adjustMenuItem(item, delta) {
    if (!item || delta === 0 || !item.set || !item.get) return;
    const curVal = item.get();
    if (item.type === "value") {
        const next = clamp(curVal + delta, item.min, item.max);
        if (next !== curVal) item.set(next);
    } else if (item.type === "enum") {
        const opts = item.options || [];
        if (opts.length === 0) return;
        const idx = opts.indexOf(curVal);
        const newIdx = ((idx < 0 ? 0 : idx) + delta + opts.length * 100) % opts.length;
        const next = opts[newIdx];
        if (next !== curVal) item.set(next);
    }
}

function handleJogTurn(delta) {
    if (delta === 0) return;
    const state = cur().menuState[currentPage];
    const items = currentPageItems();
    if (!state || !items || items.length === 0) return;

    if (state.editing) {
        adjustMenuItem(items[state.selectedIndex], delta);
        const item = items[state.selectedIndex];
        if (item && item.get) {
            const formatted = item.format ? item.format(item.get()) : String(item.get());
            showOverlay(item.label, formatted);
        }
    } else {
        const n = items.length;
        // One detent per click for navigation — don't let acceleration jump
        // multiple rows in a list this short.
        const step = delta > 0 ? 1 : -1;
        state.selectedIndex = (state.selectedIndex + step + n) % n;
    }
}

function handleJogClick() {
    const state = cur().menuState[currentPage];
    const items = currentPageItems();
    if (!state || !items || items.length === 0) return;
    const item = items[state.selectedIndex];
    if (!item) return;
    state.editing = !state.editing;
    if (state.editing) {
        const formatted = item.format ? item.format(item.get()) : String(item.get());
        showOverlay("Edit " + item.label, formatted);
    } else {
        showOverlay(item.label, "confirmed");
    }
}

function knobOverlayInfo(idx) {
    const slot = cur();
    if (slot.mode === MODE_303) {
        const label = CC_303_LABELS[idx] || "?";
        return { name: "303 " + label, value: String(slot.cc303[idx] | 0) };
    }
    switch (idx) {
        case 0: return { name: "Density", value: Math.round(slot.density * 100) + "%" };
        case 1: return { name: "Accent",  value: Math.round(slot.accent  * 100) + "%" };
        case 2: return { name: "Slide",   value: Math.round(slot.slide   * 100) + "%" };
        case 3: return { name: "Octaves", value: String(slot.octaves) };
        case 4: return { name: "Root",    value: ROOT_NAMES[slot.root] || "?" };
        case 5: return { name: "Scale",   value: SCALE_NAMES[slot.scale] || "?" };
        case 6: return { name: "Length",  value: slot.length + " steps" };
        case 7: return { name: "Gate",    value: Math.round(slot.gate * 100) + "%" };
    }
    return null;
}

function handleKnob(knobIdx, delta) {
    if (delta === 0) return;
    if (cur().mode === MODE_303) {
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

// Slot that currently hosts the 303 plugin. Refreshed on 303-mode entry and
// periodically so the UI can hide/disable 303 mode when no 303 is loaded.
let cc303SlotIdx = -1;
let has303Slot = false;

// Param keys 303 plugin exposes via get_param, matching CC_303 index order.
const CC_303_PARAM_KEYS = [
    "cutoff", "resonance", "decay", "env_mod",
    "accent", "volume", "overdrive_level", "overdrive_dry_wet"
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
    const next = clamp((slot.cc303[knobIdx] | 0) + delta, 0, 127);
    if (next === slot.cc303[knobIdx]) return;
    slot.cc303[knobIdx] = next;
    if (typeof shadow_send_midi_to_dsp === "function") {
        const chStatus = 0xB0 | ((slot.channel - 1) & 0x0F);
        shadow_send_midi_to_dsp([chStatus, cc, next]);
    }
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

    // Step buttons 1..NUM_PAGES — page selector. Current page bright, others dim.
    for (let i = 0; i < NUM_STEP_BUTTONS; i++) {
        if (i < NUM_PAGES) {
            setStepLed(i, (i === currentPage) ? LED_WHITE : LED_DARK_GREY);
        } else {
            setStepLed(i, LED_OFF);
        }
    }

    // Track buttons 1..2 — knob mode indicator. Track 2 only lights when a
    // 303 is actually loaded somewhere tb3po can reach.
    setTrackLed(CC_TRACK1, slot.mode === MODE_3PO ? LED_TEAL : LED_DARK_GREY);
    if (has303Slot) {
        setTrackLed(CC_TRACK2, slot.mode === MODE_303 ? LED_ORANGE : LED_DARK_GREY);
    } else {
        setTrackLed(CC_TRACK2, LED_OFF);
    }

    // Hardware buttons tb3po owns. Play is intentionally NOT set here —
    // we want Move firmware to drive it (passthrough capability).
    setTrackLed(CC_UP,     LED_DARK_GREY);                 // +  octave up
    setTrackLed(CC_DOWN,   LED_DARK_GREY);                 // -  octave down
    setTrackLed(CC_LEFT,   stepPageCount() > 1 ? LED_DARK_GREY : LED_OFF);
    setTrackLed(CC_RIGHT,  stepPageCount() > 1 ? LED_DARK_GREY : LED_OFF);
    setTrackLed(CC_DELETE, LED_RED);                       // X  CLEAR (red warn)
    setTrackLed(CC_UNDO,   LED_DARK_GREY);                 // Undo last op

    // Clear the force-refresh flag now that all LEDs have been written.
    ledForceNextRefresh = false;
}

// -------- Display ----------

// Action pad labels — the 8 pads on the bottom row (row 0 of the pad grid).
// Several actions live on hardware buttons instead of pads so the grid stays
// clean: CLEAR on X, octave ± on the + / − buttons, transport on Play.
const PAD_ACTION_LABELS = ["NEW", "MUT", "DIR", "Ch-", "Ch+", "", "", ""];

function drawStepGrid(y) {
    if (typeof draw_rect !== "function" || typeof fill_rect !== "function") return;
    clampStepView();
    const slot = cur();
    const pageBase = slot.stepView * 16;
    const nVisible = Math.max(0, Math.min(16, slot.length - pageBase));
    for (let i = 0; i < nVisible; i++) {
        const x = i * 8;
        const step = pageBase + i;
        const s = slot.steps[step];
        const isNow = (step === slot.position);
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
    print(0, y, "Page " + (currentPage + 1) + " " + pageName(currentPage), 1);
}

function drawPerformPage() {
    const slot = cur();
    const scaleName = (SCALE_NAMES[slot.scale] || "?").substr(0, 3);
    const rootName = ROOT_NAMES[slot.root] || "?";
    const dirName = DIRECTIONS[slot.direction] || "?";
    if (typeof print === "function") {
        // 21-char max: "Amin 120 EXT Ch1 B1 F"
        print(0, 0, rootName + scaleName + " " + (ui.bpm | 0) + " " +
                     ui.syncSource + " Ch" + slot.channel + " B" + (slot.currentBank + 1) +
                     " " + dirName.charAt(0), 1);
    }
    drawStepGrid(12);
    if (typeof print === "function") {
        const modeTxt = "knobs: " + MODE_NAMES[slot.mode];
        const pageTxt = stepPageCount() > 1 ? ("  pg" + (slot.stepView + 1) + "/" + stepPageCount()) : "";
        print(0, 26, "Pos " + (slot.position + 1) + "/" + slot.length + pageTxt + "  " + modeTxt, 1);
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

function drawMenuList(items, state, startY) {
    // Menu row style: selected row gets inverted background (fill + black text).
    // Editing shows [value] brackets. Same visual language as core menus.
    if (typeof print !== "function") return;
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const y = startY + i * 10;
        const val = it.get ? it.get() : "";
        const formatted = it.format ? it.format(val) : String(val);
        const line = it.label + ": " + formatted;
        const selected = (i === state.selectedIndex);
        const editing = selected && state.editing;
        if (selected) {
            if (typeof fill_rect === "function") fill_rect(0, y - 1, 128, 9, 1);
            const prefix = editing ? "> " : "  ";
            const shown = editing ? (it.label + ": [" + formatted + "]") : line;
            print(2, y, prefix + shown, 0);
        } else {
            print(2, y, "  " + line, 1);
        }
    }
}

function drawMutationPage() {
    const slot = cur();
    if (slot.mode === MODE_303) {
        // 303 mode — knobs 1-4 map to Cutoff/Reson/Decay/EnvMod.
        if (typeof print !== "function") return;
        print(0, 0, "303 Control 1 (K1-K4)", 1);
        print(0, 14, "K1 Cutoff: " + slot.cc303[0], 1);
        print(0, 24, "K2 Reson:  " + slot.cc303[1], 1);
        print(0, 34, "K3 Decay:  " + slot.cc303[2], 1);
        print(0, 44, "K4 EnvMod: " + slot.cc303[3], 1);
        print(0, 56, "T1 to return to 3PO", 1);
        return;
    }
    if (typeof print === "function") {
        print(0, 0, "MUTATION" + (patternStale ? "  * stale" : ""), 1);
    }
    drawMenuList(mutationPageItems(), slot.menuState[PAGE_MUTATION], 14);
    if (typeof print === "function") {
        print(0, 56, "Jog nav/edit  P1 NEW", 1);
    }
}

function drawScalePage() {
    if (typeof print !== "function") return;
    const slot = cur();
    if (slot.mode === MODE_303) {
        // 303 mode — knobs 5-8 map to Accent/Volume/Ovdrv/Ovdrv Mix.
        print(0, 0,  "303 Control 2 (K5-K8)", 1);
        print(0, 14, "K5 Accent:    " + slot.cc303[4], 1);
        print(0, 24, "K6 Volume:    " + slot.cc303[5], 1);
        print(0, 34, "K7 Overdrive: " + slot.cc303[6], 1);
        print(0, 44, "K8 Ovdrv Mix: " + slot.cc303[7], 1);
        print(0, 56, "T1 to return to 3PO", 1);
        return;
    }
    print(0, 0, "SCALE", 1);
    drawMenuList(scalePageItems(), slot.menuState[PAGE_SCALE], 14);
    print(0, 56, "Jog nav/edit  Knobs 5-8", 1);
}

function drawChannelPage() {
    if (typeof print !== "function") return;
    print(0, 0, "MIDI CHANNEL", 1);
    drawMenuList(channelPageItems(), cur().menuState[PAGE_CHANNEL], 20);
    print(0, 56, "Jog nav/edit", 1);
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
        case PAGE_CHANNEL:  drawChannelPage();  break;
        case PAGE_HELP:     drawHelpPage();     break;
        default:            drawPerformPage();
    }
    // Overlay last so it sits on top of whatever the page drew.
    drawOverlay();
}

// -------- Lifecycle ----------

globalThis.init = function() {
    console.log("[tb3po] ui init");
    // First-load nudge — tb3po emits MIDI on its configured channel but
    // doesn't itself produce audio. Without a shadow slot listening on that
    // channel, nothing is heard. Show this once on load so the user knows
    // where to point a synth.
    showOverlay("MIDI -> Ch " + cur().channel, "route a synth", 360);
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
            showOverlay("Steps", (slot.stepView * 16 + 1) + "-" + Math.min(slot.length, (slot.stepView + 1) * 16));
        }
        return;
    }
    if (type === 0xB0 && d1 === CC_RIGHT && d2 > 0) {
        const slot = cur();
        if (stepPageCount() > 1 && slot.stepView < stepPageCount() - 1) {
            slot.stepView++;
            showOverlay("Steps", (slot.stepView * 16 + 1) + "-" + Math.min(slot.length, (slot.stepView + 1) * 16));
        }
        return;
    }

    // Track 1 / Track 2 buttons switch knob mode.
    if (type === 0xB0 && d1 === CC_TRACK1 && d2 > 0) {
        cur().mode = MODE_3PO;
        showOverlay("Knob mode", "3PO");
        return;
    }
    if (type === 0xB0 && d1 === CC_TRACK2 && d2 > 0) {
        // Force a fresh slot scan on every Track 2 press so a just-loaded
        // 303 is picked up without waiting for the periodic poll.
        cc303SlotIdx = find303Slot();
        has303Slot = cc303SlotIdx >= 0;
        if (!has303Slot) {
            showOverlay("No 303 loaded", "route a 303 to Ch" + cur().channel);
            return;
        }
        cur().mode = MODE_303;
        sync303FromPlugin();
        showOverlay("Knob mode", "303 CCs");
        return;
    }

    // Knob deltas arrive as synthetic CC messages (CC 71-78).
    if (type === 0xB0 && d1 >= CC_KNOB_BASE && d1 < CC_KNOB_BASE + 8) {
        const knobIdx = d1 - CC_KNOB_BASE;
        const raw = decodeDelta(d2);
        const gain = (cur().mode === MODE_303) ? KNOB_GAIN_303 : KNOB_GAIN_3PO;
        handleKnob(knobIdx, scaleDelta(raw, gain));
        return;
    }

    // Jog wheel (CC 14) — menu navigation / value editing.
    // CHANNEL works in both knob modes (MIDI channel affects output either way);
    // MUTATION and SCALE only in 3PO mode since 303 mode reuses those pages
    // to show the live CC readouts.
    if (type === 0xB0 && d1 === 14) {
        const on3poMenu = cur().mode === MODE_3PO &&
            (currentPage === PAGE_MUTATION || currentPage === PAGE_SCALE);
        const onChannel = currentPage === PAGE_CHANNEL;
        if (!on3poMenu && !onChannel) return;
        const state = cur().menuState[currentPage];
        if (!state) return;
        // Nav mode: 1 detent = 1 row (no acceleration, prevents overshoot on
        // short lists). Edit mode: gain-scaled so fast spins sweep quickly.
        const raw = decodeDelta(d2);
        const delta = state.editing ? scaleDelta(raw, JOG_EDIT_GAIN) : raw;
        handleJogTurn(delta);
        return;
    }

    // Jog click (CC 3, main button) — enter/confirm edit.
    if (type === 0xB0 && d1 === 3 && d2 > 0) {
        const on3poMenu = cur().mode === MODE_3PO &&
            (currentPage === PAGE_MUTATION || currentPage === PAGE_SCALE);
        const onChannel = currentPage === PAGE_CHANNEL;
        if (!on3poMenu && !onChannel) return;
        handleJogClick();
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
