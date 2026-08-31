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
const { isReadOnly: META_isReadOnly, isDivable: META_isDivable } =
    await import("/data/UserData/schwung/shared/param_pages/param_meta.mjs");

/* The real hardware entry point. The picker is a DISPATCH-ORDER feature, so
 * every gesture below goes in as MIDI rather than through a test-only opener. */
const midi = (...d) => globalThis.onMidiMessageInternal(Uint8Array.from(d));
const touch   = (k) => midi(0x90, k, 127);       /* knob capacitive touch */
const untouch = (k) => midi(0x80, k, 0);
const click   = () => midi(0xB0, 3, 127);        /* jog click */
/* decodeDelta: 1..63 is CW, 65..127 is CCW as 128-value. */
const jog = (n) => midi(0xB0, 14, n >= 0 ? n : 128 + n);

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

/*
 * `channel` is an ENUM of INDICES to the grid and a channel NUMBER to the DSP
 * and to the Ch-/Ch+ action pads -- the same round trip `length` makes, pinned
 * the same way, because the two must not drift.
 */
const chMeta = ui.__test.metaFor("channel");
eq("channel is declared an enum", chMeta.type, "enum");
eq("channel declares 16 options", (chMeta.options || []).length, 16);
check("channel is DIVABLE", META_isDivable(chMeta),
      "meta was " + JSON.stringify(chMeta));
ui.__test.ui.slots[0].channel = 10;
eq("channel projects to its option INDEX",
   ui.__test.dspValues(ui.__test.ui.slots[0]).channel, 9);
writes.length = 0;
ui.__test.editKey("channel", 40);
const chWrite = writes.find((w) => w[0] === "a.channel");
check("channel writes a channel NUMBER, not an index",
      !!chWrite && Number(chWrite[1]) >= 1 && Number(chWrite[1]) <= 16 &&
      Number(chWrite[1]) === ui.__test.ui.slots[0].channel,
      "wrote " + JSON.stringify(chWrite) + " slot=" + ui.__test.ui.slots[0].channel);

/* The Ch-/Ch+ ACTION PADS (row 0, cols 3 and 4 = notes 71 and 72) still write
 * a channel number directly. An index leaking onto this path is exactly the
 * regression the enum conversion could have caused. */
ui.__test.ui.slots[0].channel = 4;
writes.length = 0;
for (let i = 0; i < 4; i++) midi(0x90, 72, 127);   /* Ch+ */
const padWrite = writes.filter((w) => w[0] === "a.channel").pop();
check("Ch+ pad writes a channel NUMBER",
      !!padWrite && Number(padWrite[1]) === ui.__test.ui.slots[0].channel &&
      Number(padWrite[1]) >= 1 && Number(padWrite[1]) <= 16,
      "wrote " + JSON.stringify(padWrite) + " slot=" + ui.__test.ui.slots[0].channel);

/* ---------------------------------------------------------------- picker
 *
 * Touch a knob, click the jog. Driven through the REAL MIDI entry point, not
 * through an opener exported for the test: the whole feature is a question of
 * DISPATCH ORDER, and a helper that skips the dispatch cannot answer it.
 */
ui.__test.pageIndex[0] = setupIdx;
eq("Setup knob 2 -> direction", ui.keyForKnob(1), "direction");
eq("Setup knob 1 -> channel",   ui.keyForKnob(0), "channel");

check("nothing is held, so a click opens nothing",
      (click(), ui.__test.picker() === null));

/* A DIVABLE key opens it. */
ui.__test.ui.slots[0].direction = 0;
touch(1); click();
let pk = ui.__test.picker();
check("holding Direction and clicking opens the picker", pk !== null);
eq("...on the right key", pk && pk.key, "direction");
eq("...with the declared options", pk && pk.options.join(","), "Fwd,Rev,Ping,Rnd");
eq("...opened at the LIVE index", pk && pk.index, 0);
eq("...and marks the live value", pk && pk.openIndex, 0);

/* The jog moves the selection one row per detent, and clamps. */
jog(2);
eq("jog turn moves the selection 1:1", ui.__test.picker().index, 2);
jog(-40);
eq("jog clamps at the top", ui.__test.picker().index, 0);
jog(40);
eq("jog clamps at the bottom", ui.__test.picker().index, 3);

/* KNOBS AND PADS ARE INERT UNDERNEATH IT. */
writes.length = 0;
midi(0xB0, 71, 40);                 /* knob 1 */
midi(0x90, 68, 127);                /* pad row 0 col 0 = regenerate */
midi(0x90, 16 + 3, 127);            /* step button 4 = page jump */
eq("knobs and pads write nothing while the picker is open", writes.length, 0);
eq("...and the page did not change", ui.__test.curPage().name, "Setup");
check("...and the picker is still open", ui.__test.picker() !== null);

/* One frame through the real draw path with the picker up. */
{
    let threw = null;
    try { globalThis.tick(); } catch (e) { threw = e; }
    check("tick() draws the picker", threw === null, threw && threw.message);
}

/* A second click COMMITS the selection. */
writes.length = 0;
click();
check("a second click closes the picker", ui.__test.picker() === null);
eq("...committing the selected index", ui.__test.ui.slots[0].direction, 3);
const dirWrite = writes.find((w) => w[0] === "a.direction");
eq("...and writing it to the DSP", dirWrite && dirWrite[1], "3");
untouch(1);

/* Channel commits a NUMBER, from an index. */
ui.__test.ui.slots[0].channel = 1;
touch(0); click();
check("holding MIDI Ch and clicking opens the picker", ui.__test.picker() !== null);
jog(9);
writes.length = 0;
click();
eq("channel commits index+1 to the slot", ui.__test.ui.slots[0].channel, 10);
const chCommit = writes.find((w) => w[0] === "a.channel");
eq("...and writes the channel number", chCommit && chCommit[1], "10");
untouch(0);

/*
 * A NON-divable key refuses. 303.cutoff is an int 0..127 -- a list of 128 is
 * not a picker -- and transpose is an int -48..48.
 *
 * TWO REDUNDANT BARRIERS, and neither is individually mutation-covered on
 * today's contract, so this says so rather than implying otherwise. openPicker
 * refuses a key that is not `divable` AND refuses an empty option list, and
 * every non-divable key TB-3PO declares happens to fail both (an int carries no
 * `options`). Proven by mutation: deleting either one alone leaves the suite
 * green; deleting BOTH fails "holding a plain int and clicking opens nothing".
 * A read-only ENUM would separate them, and TB-3PO declares none.
 *
 * So the DECLARATIONS are asserted separately, exactly as the current_bank
 * readout above is: `isDivable` is the shared predicate the grid uses, and a
 * key whose declaration stops matching it is what these catch.
 */
ui.__test.pageIndex[0] = r.findIndex((p) => p.name === "303");
if (ui.__test.pageIndex[0] < 0) ui.__test.pageIndex[0] = setupIdx;
{
    const cutMeta = ui.__test.metaFor("303.cutoff");
    check("303.cutoff is NOT divable", !META_isDivable(cutMeta));
}
ui.__test.pageIndex[0] = setupIdx;
touch(2);                            /* Setup knob 3 = transpose, an int */
click();
check("holding a plain int and clicking opens nothing", ui.__test.picker() === null);
untouch(2);

/* A READOUT refuses, and for its own reason: `divable` excludes read-only by
 * construction, so this holds without a second rule in ui.js. */
check("current_bank is NOT divable", !META_isDivable(ui.__test.metaFor("current_bank")));
touch(3);                            /* Setup knob 4 = current_bank */
click();
check("holding the Bank readout and clicking opens nothing",
      ui.__test.picker() === null);
untouch(3);

/* A knob with no key at all (Setup 5-8) is not a door either. */
touch(4);
click();
check("holding an empty cell and clicking opens nothing", ui.__test.picker() === null);
untouch(4);

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
