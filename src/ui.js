// TB-3PO UI — pad/knob/display bridge. All sequencing lives in dsp.so.
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
const CC_KNOB_BASE = 71;        // CCs 71..78 = knobs 1..8
const CC_SHIFT = 49;
const CC_BACK = 51;

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
    steps: new Array(32).fill(STEP_REST)
};

let pollTick = 0;
let shiftHeld = false;

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

function handleKnob(knobIdx, delta) {
    if (delta === 0) return;
    switch (knobIdx) {
        case 0: adjustFloat("density", "density", delta, 0.01, 0, 1); break;
        case 1: adjustFloat("accent",  "accent",  delta, 0.01, 0, 1); break;
        case 2: adjustFloat("slide",   "slide",   delta, 0.01, 0, 1); break;
        case 3: adjustInt("octaves",   "octaves", delta, 1, 3); break;
        case 4: adjustEnum("root",     "root",    delta, 12); break;
        case 5: adjustEnum("scale",    "scale",   delta, SCALE_NAMES.length); break;
        case 6: adjustLength(delta); break;
        case 7: adjustFloat("gate",    "gate",    delta, 0.05, 0.1, 1.0); break;
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

    if (row === 3) {                     // top row: steps 1-8
        cycleStepState(col);
    } else if (row === 2) {              // steps 9-16
        cycleStepState(8 + col);
    } else if (row === 1) {              // banks (Shift = store, plain = recall)
        if (shiftHeld) {
            setDspParam("store_bank", String(col));
            ui.currentBank = col;
        } else {
            setDspParam("recall_bank", String(col));
            ui.currentBank = col;
        }
    } else {                             // row 0: actions
        switch (col) {
            case 0: setDspParam("generate", "0"); break;                                 // New
            case 1: setDspParam("mutate", "1"); break;                                    // Mutate
            case 2:                                                                        // Direction cycle
                ui.direction = (ui.direction + 1) & 3;
                setDspParam("direction", String(ui.direction));
                break;
            case 3: setDspParam("clear", "1"); break;                                     // Clear
            case 4: setDspParam("running", "0"); break;                                    // Stop
            case 5: setDspParam("running", "1"); break;                                    // Play
            case 6:                                                                        // Channel down
                adjustInt("channel", "channel", -1, 1, 16);
                break;
            case 7:                                                                        // Channel up
                adjustInt("channel", "channel", +1, 1, 16);
                break;
        }
    }
}

// -------- Display ----------

function draw() {
    if (typeof clear_screen !== "function") return;
    clear_screen();

    const scaleName = SCALE_NAMES[ui.scale] || "?";
    const rootName = ROOT_NAMES[ui.root] || "?";
    const dirName = DIRECTIONS[ui.direction] || "?";

    if (typeof print === "function") {
        print(0, 0, "TB-3PO " + rootName + scaleName + " BPM" + (ui.bpm | 0) + " Ch" + ui.channel, 1);
    }

    // Step grid — 16 cells across top, each 8px wide.
    const nVisible = Math.min(ui.length, 16);
    for (let i = 0; i < nVisible; i++) {
        const x = i * 8;
        const s = ui.steps[i];
        const isNow = (i === ui.position);
        if (s === STEP_REST) {
            if (typeof draw_rect === "function") draw_rect(x + 1, 14, 6, 6, 1);
        } else if (s === STEP_NOTE) {
            if (typeof fill_rect === "function") fill_rect(x + 2, 15, 4, 4, 1);
        } else if (s === STEP_ACCENT) {
            if (typeof fill_rect === "function") fill_rect(x + 1, 14, 6, 6, 1);
        } else if (s === STEP_SLIDE) {
            if (typeof fill_rect === "function") fill_rect(x + 1, 14, 6, 6, 1);
            if (typeof draw_line === "function") draw_line(x, 22, x + 8, 22, 1);
        }
        if (isNow && typeof draw_rect === "function") draw_rect(x, 12, 8, 10, 1);
    }

    if (typeof print === "function") {
        print(0, 28, "D" + Math.round(ui.density * 100) +
                     " A" + Math.round(ui.accent * 100) +
                     " S" + Math.round(ui.slide * 100) +
                     " Oct" + ui.octaves, 1);
        print(0, 40, "Len" + ui.length + " Gate" + Math.round(ui.gate * 100) +
                     " Dir" + dirName + " Bnk" + (ui.currentBank + 1), 1);
        print(0, 54, "Back=hide Shift+Back=exit", 1);
    }
}

// -------- Lifecycle ----------

globalThis.init = function() {
    console.log("[tb3po] ui init");
};

globalThis.tick = function() {
    pollDsp();
    draw();
};

globalThis.onMidiMessageInternal = function(data) {
    if (!data) return;
    const status = data[0] | 0;
    const d1 = data[1] | 0;
    const d2 = data[2] | 0;
    const type = status & 0xF0;

    // Track shift locally (the overtake MIDI dispatcher also tracks it, but JS doesn't see that).
    if (type === 0xB0 && d1 === CC_SHIFT) {
        shiftHeld = (d2 > 0);
        return;
    }
    if (type === 0xB0 && d1 === CC_BACK) {
        // Host intercepts Back for suspend/exit — we never see the press here.
        // (Release may leak through; ignore.)
        return;
    }

    // Knob deltas arrive as synthetic CC messages (CC 71-78).
    if (type === 0xB0 && d1 >= CC_KNOB_BASE && d1 < CC_KNOB_BASE + 8) {
        const knobIdx = d1 - CC_KNOB_BASE;
        handleKnob(knobIdx, decodeDelta(d2));
        return;
    }

    // Pads are note-on/off on notes 68-99.
    if (type === 0x90 && d1 >= NOTE_PAD_BASE && d1 <= NOTE_PAD_BASE + 31) {
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
