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
/* Semitones for each `transpose` option index. The DSP speaks semitones. */
export const TRANSPOSE_SEMIS = [-48, -36, -24, -12, 0, 12, 24, 36, 48];
export const TRANSPOSE_OPTIONS = ["-4 oct", "-3 oct", "-2 oct", "-1 oct", "0 oct",
                                  "+1 oct", "+2 oct", "+3 oct", "+4 oct"];
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
 */
/*
 * These two enums wire their VALUE as text, not an index.
 *
 * `options_as_string` is not a workaround, it is what the DSP speaks: `length`
 * takes a step COUNT and `channel` a channel NUMBER, so "16" and "10" are the
 * literal wire values and ui.js reads the integer straight out of them.
 *
 * The option text used to be padded -- "Ch 10", "16 Steps" -- for a different
 * reason, and that one WAS a workaround. The host's formatParamForSet resolved
 * an enum by `options.indexOf(String(value))` BEFORE reading the value as an
 * index, so an option whose text was a small decimal shadowed that index:
 * index 7 matched the option named "7" and set channel 7 instead of 8,
 * silently, on the knob and in the picker, for thirteen of the sixteen. The
 * padding made the text un-shadowable and `short_options` put the bare number
 * back in the 30px cell.
 *
 * schwung#376 fixed the precedence -- a number is an index, a name is a name --
 * so the padding buys nothing now and cost a word in every picker row. There
 * is no host that can run this module and still has the bug: TB-3PO already
 * requires the embedding API, which merged the same day.
 */
export const CHANNELS = Array.from({ length: 16 }, (_, i) => String(i + 1));
export const LENGTH_OPTIONS = LENGTHS.map(String);

/*
 * AN ENUM OPTION MUST NEVER READ AS ONE OF ITS OWN INDICES.
 *
 * `length` and `channel` are the two enums here whose options are quantities,
 * and both used to be PROJECTED: the grid held an index and ui.js converted at
 * every edge. Once the shared page controller owns the knob dispatch that
 * projection stops being safe, and the reason is worth stating exactly,
 * because nothing fails when it is got wrong.
 *
 * `formatParamForSet` (shared/param_format.mjs) resolves an enum value like
 * this, and the order is unconditional:
 *
 *     const labelIdx = meta.options.indexOf(String(rawValue));
 *     idx = labelIdx >= 0 ? labelIdx : Math.round(Number(rawValue));
 *
 * The knob engine's value IS an index, so with options named "1".."16" the
 * index 7 matches the OPTION named "7" and the write lands on option 6 --
 * channel 7 where the user asked for 8. Measured: wrong for thirteen of the
 * sixteen, on the knob and on the picker alike, with the cell showing the
 * value the grid believes it wrote. `enumIndexOf` has the mirror of it on the
 * read, and `learnEnumWireFormat` would latch the wrong convention off the
 * first reading. LENGTHS' "8","16","24","32" were safe only because "0".."3"
 * happen not to be among them -- one added option from unsafe, with nothing to
 * say so.
 *
 * TWO declarations settle it together:
 *
 *   the option TEXT is never a bare decimal ("Ch 8", "16 Steps"), so no index
 *   can shadow an option;
 *
 *   `options_as_string: true` says the wire value IS that text, by
 *   declaration, and is never learned over.
 *
 * So the wire reads "16 Steps" and "Ch 10", ui.js takes the integer out of it,
 * and there is no index anywhere. `short_options` keeps the 30px cell showing
 * the bare number, and never reaches the wire.
 */

export const TB3PO_PARAMS = [
    { key: "density", label: "Density", short_name: "Dens",  type: "float", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "accent",  label: "Accent",  short_name: "Acc",   type: "float", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "slide",   label: "Slide",   short_name: "Slide", type: "float", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "gate",    label: "Gate",    short_name: "Gate",  type: "float", min: 0.1, max: 1, step: 0.01, unit: "%" },
    { key: "root",    label: "Root",    short_name: "Root",  type: "enum",  options: ROOT_NAMES },
    { key: "scale",   label: "Scale",   short_name: "Scale", type: "enum",  options: SCALE_NAMES },
    { key: "length",  label: "Length",  short_name: "Len",   type: "enum",
      options: LENGTH_OPTIONS, options_as_string: true },
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

    { key: "channel",   label: "MIDI Ch",   short_name: "Chan", type: "enum", options: CHANNELS,
      options_as_string: true },
    { key: "direction", label: "Direction", short_name: "Dir",  type: "enum", options: DIRECTIONS },
    /*
     * OCTAVES, declared as octaves.
     *
     * The DSP stores SEMITONES and clamps to +/-48 (tb3po.c:841), and the +/-
     * buttons have always stepped by 12 -- so the range is four octaves either
     * way and that is not new. What was wrong is that the cell said `OCT+` and
     * showed `-48`: a label promising octaves over a number counting
     * semitones. Turning it read -12, -24, -36, -48.
     *
     * Declared as an enum, the cell shows what the label claims, and the value
     * becomes divable -- nine options is a list worth opening. The index maps
     * to semitones as (index - 4) * 12; see TRANSPOSE_SEMIS.
     *
     * No option is a bare numeral, "0 oct" included. That is deliberate: an
     * enum whose option text can read as a decimal is written wrong by the
     * host's formatParamForSet (schwung#376) -- index 0 would resolve as the
     * position of the option named "0". Once that lands this could be "0",
     * but it reads better as "0 oct" anyway.
     */
    { key: "transpose", label: "Transpose", short_name: "Oct", type: "enum",
      options: TRANSPOSE_OPTIONS,
      short_options: ["-4", "-3", "-2", "-1", "0", "+1", "+2", "+3", "+4"] },
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
 * pages has nothing to refuse — the bank bar draws five segments and the
 * buttons that would have gone there land on Pattern.
 */
export function pagesFor({ has303 }) {
    const pages = [PAGE_PERFORM, PAGE_PATTERN];
    if (has303) pages.push(PAGE_303);
    pages.push(PAGE_SETUP, PAGE_PADS, PAGE_KEYS);
    return pages;
}

/*
 * THE `ui_hierarchy` TB-3PO PUBLISHES TO ITS OWN PAGE CONTROLLER.
 *
 * TB-3PO is a tool: nothing on the wire serves it a contract, so it declares
 * one for itself and answers `synth:ui_hierarchy` out of this function. The
 * shared controller then plans, paginates, dispatches and draws the three knob
 * pages, and TB-3PO keeps the four it owns (Steps, Pads, Keys, and the chrome
 * around all of them).
 *
 * DERIVED FROM THE PAGE OBJECTS, never re-listed. The hierarchy is now the
 * SOLE definition of which params are reachable, and it fails silently: drop a
 * key here and the cell simply is not planned — no orphan page, no warning,
 * nothing on screen to notice. That is why the key lists come from PAGE_*
 * rather than being typed a second time, and why tests/params.mjs asserts that
 * every declared param lands on some planned page.
 *
 * The walk order is load-bearing: planPages emits root's grid first, then
 * visits `params` level edges in order. So the controller's pages come out as
 * Pattern, 303, Setup — the same relative order pagesFor() gives them, which
 * is what lets one index map onto the other.
 *
 * The root level's grid page is named "Main" by the planner whatever this
 * declares (16 modules would otherwise open on a page called "Patch"). That
 * name is never shown: TB-3PO's own page set is the sole authority for
 * anything user-visible, and the header is drawn from `PAGE_*.name`.
 */
export function hierarchyFor({ has303 }) {
    const levels = {
        root: {
            label: PAGE_PATTERN.name,
            knobs: PAGE_PATTERN.keys.filter(Boolean),
            params: [
                ...(has303 ? [{ level: "fx303", label: PAGE_303.name }] : []),
                { level: "setup", label: PAGE_SETUP.name },
            ],
        },
        setup: { label: PAGE_SETUP.name, knobs: PAGE_SETUP.keys.filter(Boolean) },
    };
    if (has303) levels.fx303 = { label: PAGE_303.name, knobs: PAGE_303.keys.filter(Boolean) };
    return { modes: null, levels };
}

/**
 * Which of the controller's knob pages backs the outer page at `outerIndex`.
 *
 * ONE FUNCTION, because there are now two indices and they must not be kept in
 * step at each call site. TB-3PO owns 0..5 over `pagesFor()`; the controller
 * owns 0..2 over the pages `hierarchyFor()` plans. The mapping is positional:
 * the n-th knob page of the outer set is the n-th planned page, which is what
 * makes the derivation above load-bearing.
 *
 * PERFORM maps to the Pattern page rather than to nothing. Its four live knobs
 * ARE Pattern's row 0 — the same four in the same positions — so parking the
 * controller there gives that row its dispatch, its knob engine and its values
 * from the same place the Pattern page gets them, instead of a second copy.
 *
 * Pads and Keys return -1: nothing of the controller is shown, so nothing
 * should move.
 */
export function controllerPageFor(pages, outerIndex) {
    const page = pages[outerIndex];
    if (!page) return -1;
    if (page.kind !== "knobs" && page.kind !== "perform") return -1;
    let n = 0;
    for (let i = 0; i < outerIndex; i++) if (pages[i].kind === "knobs") n++;
    /* PERFORM sits BEFORE Pattern and counts none, which lands it on 0 — the
     * Pattern page — exactly as intended. */
    return n;
}
