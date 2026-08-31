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
/*
 * MIDI channels as an ENUM, for the same reason `length` is one.
 *
 * Declared `type: "int"` a channel is turnable but NOT divable — `meta.divable`
 * is `(opaqueType || listableEnum) && !readOnly && !writeOnly`, and an int is
 * neither — so the only way to reach channel 14 was to spin a knob through
 * thirteen values you cannot see ahead of. As an enum it earns the option
 * picker, and the feel is unchanged: knob_engine gates every enum at
 * ENUM_DELTA_DIV detents per option, which is exactly what a 1..16 int already
 * got (NARROW_RANGE_MAX is 16).
 *
 * The cost is the same projection `length` already pays: the grid reads and
 * writes an INDEX, the DSP and the Ch-/Ch+ pads speak channel NUMBERS, and
 * ui.js is the one place the two are converted (dspValues / adjustChannel).
 */
export const CHANNELS = Array.from({ length: 16 }, (_, i) => String(i + 1));

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

    { key: "channel",   label: "MIDI Ch",   short_name: "Chan", type: "enum", options: CHANNELS },
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
