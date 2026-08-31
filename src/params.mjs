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

    { key: "cutoff",   label: "Cutoff",    short_name: "Cut", type: "int", min: 0, max: 127, step: 1 },
    { key: "reson",    label: "Resonance", short_name: "Res", type: "int", min: 0, max: 127, step: 1 },
    { key: "decay",    label: "Decay",     short_name: "Dec", type: "int", min: 0, max: 127, step: 1 },
    { key: "envmod",   label: "Env Mod",   short_name: "Env", type: "int", min: 0, max: 127, step: 1 },
    { key: "acc303",   label: "Accent",    short_name: "Acc", type: "int", min: 0, max: 127, step: 1 },
    { key: "volume",   label: "Volume",    short_name: "Vol", type: "int", min: 0, max: 127, step: 1 },
    { key: "drive",    label: "Drive",     short_name: "Drv", type: "int", min: 0, max: 127, step: 1 },
    { key: "drivemix", label: "Drive Mix", short_name: "Mix", type: "int", min: 0, max: 127, step: 1 },

    { key: "channel",   label: "MIDI Ch",   short_name: "Chan", type: "int",  min: 1, max: 16, step: 1 },
    { key: "direction", label: "Direction", short_name: "Dir",  type: "enum", options: DIRECTIONS },
    { key: "transpose", label: "Transpose", short_name: "Oct+", type: "int",  min: -48, max: 48, step: 12 },
    { key: "bank",      label: "Bank",      short_name: "Bank", type: "int",  min: 1, max: 8, step: 1 },
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
    keys: ["cutoff", "reson", "decay", "envmod", "acc303", "volume", "drive", "drivemix"] };
/* Four knobs, four empty. Leaving it half-empty is a decision, not an
 * oversight: the alternative is moving a param off Pattern to fill space. */
export const PAGE_SETUP = { name: "Setup", kind: "knobs",
    keys: ["channel", "direction", "transpose", "bank", null, null, null, null] };
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
