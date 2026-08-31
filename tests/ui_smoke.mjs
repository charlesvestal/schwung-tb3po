/*
 * Module-level wiring of src/ui.js.
 *
 * Nothing else covers this file: the render tests draw src/pages.mjs directly,
 * and ui.js is the layer that decides WHICH key a physical knob edits and
 * whether a turn writes anything. Those two decisions are the whole of Task 7,
 * so they are what this asserts.
 *
 * The device globals are stubbed BEFORE the import, because ui.js is loaded by
 * shadow_load_ui_module on hardware and reads them off globalThis.
 */
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

/* Every device binding ui.js or the shared library may touch. `print` is a
 * real global name on the device, not console output. */
const writes = [];
Object.assign(globalThis, {
    print: () => {},
    fill_rect: () => {},
    draw_rect: () => {},
    draw_line: () => {},
    text_width: (s) => String(s).length * 6,
    clear_screen: () => {},
    host_module_set_param: (k, v) => { writes.push([k, v]); },
    host_module_get_param: () => "",
    shadow_get_param: () => "",
    /* refreshLeds runs on the same tick as draw(); the shared LED helpers
     * write through this one. */
    move_midi_internal_send: () => true,
    shadow_send_midi_to_dsp: () => {},
});
globalThis.console = globalThis.console || { log: () => {} };

const ui = await import("../src/ui.js");
const { isReadOnly: META_isReadOnly } =
    await import("/data/UserData/schwung/shared/param_pages/param_meta.mjs");

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log("ok   " + name); return; }
    failures++;
    console.error("FAIL " + name + (detail ? ": " + detail : ""));
}
function eq(name, got, want) {
    check(name, got === want, "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}

/* Page 0 of a fresh ring is PERFORM, and no 303 has been found, so the ring is
 * the five-page one. */
const r = ui.ring();
eq("ring is 5 pages with no 303", r.length, 5);
eq("ring[0] is the perform page", r[0].kind, "perform");
eq("page 0 is shown by default", ui.__test.curPage().name, "Steps");

/* PERFORM inherits Pattern's ROW 0 -- the same four in the same positions. */
eq("PERFORM knob 1 -> density", ui.keyForKnob(0), "density");
eq("PERFORM knob 2 -> accent",  ui.keyForKnob(1), "accent");
eq("PERFORM knob 3 -> slide",   ui.keyForKnob(2), "slide");
eq("PERFORM knob 4 -> gate",    ui.keyForKnob(3), "gate");
for (let i = 4; i < 8; i++) {
    eq("PERFORM knob " + (i + 1) + " is inert", ui.keyForKnob(i), null);
}

/* Pattern's row 1 is the notes row. */
const patternIdx = r.findIndex((p) => p.name === "Pattern");
ui.__test.pageIndex[0] = patternIdx;
eq("Pattern knob 5 -> root",    ui.keyForKnob(4), "root");
eq("Pattern knob 8 -> octaves", ui.keyForKnob(7), "octaves");

/* Setup: Bank is knob 4, and knobs 5-8 are declared null. */
const setupIdx = r.findIndex((p) => p.name === "Setup");
ui.__test.pageIndex[0] = setupIdx;
eq("Setup knob 4 -> current_bank", ui.keyForKnob(3), "current_bank");
eq("Setup knob 5 has no key",      ui.keyForKnob(4), null);

/*
 * A READOUT shows its reading and writes nothing.
 *
 * TWO BARRIERS, and this test asserts both, because the no-write assertion
 * alone is not sensitive to either one: disabling handleKnob's isReadOnly
 * guard still writes nothing, since current_bank also has no KEY_FIELD entry
 * for editKey to route. Proven by mutation. So the declaration is asserted
 * separately -- an `access: "read"` dropped from params.mjs would leave a
 * turnable dial writing a key the DSP does not accept, and only this catches
 * it.
 */
check("current_bank is DECLARED a readout",
      META_isReadOnly(ui.__test.metaFor("current_bank")),
      "meta was " + JSON.stringify(ui.__test.metaFor("current_bank")));
check("current_bank has no write route",
      ui.__test.keyField("current_bank") === undefined);
writes.length = 0;
ui.__test.handleKnob(3, 40);
eq("turning the Bank readout writes nothing", writes.length, 0);

/* ...while the knob beside it, which is a real param, does write. Without this
 * the assertion above would also pass on a handleKnob that did nothing. */
writes.length = 0;
ui.__test.handleKnob(0, 40);
check("turning MIDI Ch on the same page does write",
      writes.some((w) => w[0] === "a.channel"),
      "writes were " + JSON.stringify(writes));

/* `length` is an enum of INDICES to the grid and a step COUNT to the DSP. */
ui.__test.pageIndex[0] = patternIdx;
ui.__test.ui.slots[0].length = 16;
eq("length projects to its option INDEX", ui.__test.dspValues(ui.__test.ui.slots[0]).length, 1);
writes.length = 0;
ui.__test.editKey("length", 40);
const lenWrite = writes.find((w) => w[0] === "a.length");
check("length writes a step COUNT, not an index",
      !!lenWrite && ["8", "16", "24", "32"].indexOf(lenWrite[1]) >= 0,
      "wrote " + JSON.stringify(lenWrite));

/* The lifecycle exports the host calls are all present. */
for (const fn of ["init", "tick", "onMidiMessageInternal", "onMidiMessageExternal", "onUnload"]) {
    check("globalThis." + fn + " is a function", typeof globalThis[fn] === "function");
}

/* One full frame through the real draw path, to prove drawPage is reachable
 * with the view object ui.js actually builds. */
for (const idx of r.keys()) {
    ui.__test.pageIndex[0] = idx;
    let threw = null;
    try { globalThis.tick(); } catch (e) { threw = e; }
    check("tick() draws page " + r[idx].name, threw === null, threw && threw.message);
}

console.log(failures === 0 ? "ui_smoke: all passed" : "ui_smoke: " + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
