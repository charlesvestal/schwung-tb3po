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

/*
 * THE REAL LIFECYCLE ENTRY, before anything is asked.
 *
 * `init()` is where the controller reads TB-3PO's contract, plans its pages
 * and warms the landing page's values -- so before it runs there is no page
 * set, no meta index and no answer to "which key does knob 3 drive". On
 * hardware the host calls it; here nothing else will.
 */
globalThis.init();

/* The real hardware entry point. The picker is a DISPATCH-ORDER feature, so
 * every gesture below goes in as MIDI rather than through a test-only opener. */
const midi = (...d) => globalThis.onMidiMessageInternal(Uint8Array.from(d));
const touch   = (k) => midi(0x90, k, 127);       /* knob capacitive touch */
const untouch = (k) => midi(0x80, k, 0);
const click   = () => midi(0xB0, 3, 127);        /* jog click */
/* decodeDelta: 1..63 is CW, 65..127 is CCW as 128-value. */
const jog = (n) => midi(0xB0, 14, n >= 0 ? n : 128 + n);
/* A knob CC as the OVERTAKE path delivers it: the value is the accumulated
 * detent COUNT for the frame, not a single tick. */
const knob = (slot, n) => midi(0xB0, 71 + slot, n >= 0 ? n : 128 + n);
/*
 * A WRITE IS THROTTLED, so a turn is not a write yet.
 *
 * The controller coalesces writes to a key at SETPARAM_THROTTLE_MS and leaves
 * the latest in `pendingWrite` for the next tick to flush -- which is a real
 * behaviour change from the old per-detent dispatch, and one a test that never
 * ticks would read as "the knob does nothing". tick() is the host's own call,
 * so this is the real flush and not a test-only door.
 */
const flush = () => {
    /* Past the throttle window, then the host's own tick. Busy-waited rather
     * than awaited so the assertions below stay in reading order. */
    const until = Date.now() + 25;
    while (Date.now() < until) { /* spin */ }
    globalThis.tick();
};

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log("ok   " + name); return; }
    failures++;
    console.error("FAIL " + name + (detail ? ": " + detail : ""));
}
function eq(name, got, want) {
    check(name, got === want, "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}

/* Page 0 of a fresh pages is PERFORM, and no 303 has been found, so the pages is
 * the five-page one. */
const r = ui.pages();
eq("pages is 5 pages with no 303", r.length, 5);
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
ui.__test.showPage(patternIdx);
eq("Pattern knob 5 -> root",    ui.keyForKnob(4), "root");
eq("Pattern knob 8 -> octaves", ui.keyForKnob(7), "octaves");

/* Setup: Bank is knob 4, and knobs 5-8 are declared null. */
const setupIdx = r.findIndex((p) => p.name === "Setup");
ui.__test.showPage(setupIdx);
eq("Setup knob 4 -> current_bank", ui.keyForKnob(3), "current_bank");
eq("Setup knob 5 has no key",      ui.keyForKnob(4), null);

/*
 * A READOUT shows its reading and writes nothing.
 *
 * The guard is the CONTROLLER'S now -- `isTurnable` excludes a readOnly param,
 * so `onKnobTurn` swallows the motion -- and there is no second barrier left
 * in ui.js to hide behind. Driven through the real knob CC for exactly that
 * reason: nothing between the encoder and the DSP is skipped.
 */
check("current_bank is DECLARED a readout",
      META_isReadOnly(ui.__test.metaFor("current_bank")),
      "meta was " + JSON.stringify(ui.__test.metaFor("current_bank")));
eq("Setup knob 4 is current_bank", ui.keyForKnob(3), "current_bank");
writes.length = 0;
for (let i = 0; i < 20; i++) knob(3, +3);
eq("turning the Bank readout writes nothing", writes.length, 0);

/* ...while the knob beside it, which is a real param, does write. Without this
 * the assertion above would also pass on a dispatch that did nothing at all. */
writes.length = 0;
for (let i = 0; i < 20; i++) knob(0, +3);
flush();
check("turning MIDI Ch on the same page does write",
      writes.some((w) => w[0] === "a.channel"),
      "writes were " + JSON.stringify(writes));

/*
 * `length` AND `channel` ARE ENUMS WHOSE OPTIONS ARE NUMERALS, and the wire
 * value is the option TEXT -- a step COUNT and a channel NUMBER, which is what
 * the DSP and the Ch-/Ch+ pads speak.
 *
 * There is no index projection left anywhere, and that is the point: the
 * controller writes through `formatParamForSet`, which resolves an enum by
 * asking `options.indexOf(String(value))` FIRST. For CHANNELS that lookup
 * SUCCEEDS on an index -- index 3 is the name of option 2 -- so an index on
 * this wire comes back one channel short for thirteen of the sixteen, in
 * silence. `options_as_string` is what settles it, so it is asserted as a
 * DECLARATION as well as through the round trip.
 */
const lenMeta = ui.__test.metaFor("length");
check("length declares options_as_string", !!lenMeta.options_as_string,
      "meta was " + JSON.stringify(lenMeta));
ui.__test.showPage(patternIdx);
ui.__test.ui.slots[0].length = 16;
eq("length reads its step COUNT", ui.__test.getParam("length"), "16 Steps");
writes.length = 0;
for (let i = 0; i < 30; i++) knob(6, +3);        /* Pattern knob 7 = length */
flush();
const lenWrite = writes.filter((w) => w[0] === "a.length").pop();
check("length writes a step COUNT, not an index",
      !!lenWrite && ["8", "16", "24", "32"].indexOf(lenWrite[1]) >= 0,
      "wrote " + JSON.stringify(lenWrite));
eq("...and the slot agrees with the wire",
   String(ui.__test.ui.slots[0].length), lenWrite && lenWrite[1]);

const chMeta = ui.__test.metaFor("channel");
eq("channel is declared an enum", chMeta.type, "enum");
eq("channel declares 16 options", (chMeta.options || []).length, 16);
check("channel declares options_as_string", !!chMeta.options_as_string,
      "meta was " + JSON.stringify(chMeta));
check("channel is DIVABLE", META_isDivable(chMeta),
      "meta was " + JSON.stringify(chMeta));
ui.__test.showPage(setupIdx);
ui.__test.ui.slots[0].channel = 10;
ui.__test.noteExternalChange("channel");
eq("channel reads its channel NUMBER", ui.__test.getParam("channel"), "Ch 10");
writes.length = 0;
for (let i = 0; i < 20; i++) knob(0, +3);
flush();
const chWrite = writes.filter((w) => w[0] === "a.channel").pop();
check("channel writes a channel NUMBER, not an index",
      !!chWrite && Number(chWrite[1]) >= 1 && Number(chWrite[1]) <= 16 &&
      Number(chWrite[1]) === ui.__test.ui.slots[0].channel,
      "wrote " + JSON.stringify(chWrite) + " slot=" + ui.__test.ui.slots[0].channel);
check("...and it MOVED, so the round trip is not a fixed point",
      ui.__test.ui.slots[0].channel !== 10,
      "channel is still " + ui.__test.ui.slots[0].channel);

/* The Ch-/Ch+ ACTION PADS (row 0, cols 3 and 4 = notes 71 and 72) write a
 * channel number directly, one press one channel. */
ui.__test.ui.slots[0].channel = 4;
ui.__test.noteExternalChange("channel");
writes.length = 0;
for (let i = 0; i < 4; i++) midi(0x90, 72, 127);   /* Ch+ */
const padWrite = writes.filter((w) => w[0] === "a.channel").pop();
eq("Ch+ steps one channel per press", ui.__test.ui.slots[0].channel, 8);
check("Ch+ pad writes a channel NUMBER",
      !!padWrite && Number(padWrite[1]) === ui.__test.ui.slots[0].channel,
      "wrote " + JSON.stringify(padWrite) + " slot=" + ui.__test.ui.slots[0].channel);

/*
 * A PAD EDIT MUST REACH THE GRID'S KNOB ENGINE, not just the DSP.
 *
 * The engine seeds its running value once per key and never re-syncs, so
 * without noteExternalChange the first detent after four Ch+ presses steps
 * from where the KNOB was and snaps the channel back. Asserted as the
 * behaviour rather than as the call: turn one detent and the value must move
 * away from 8, not back toward 4.
 */
writes.length = 0;
for (let i = 0; i < 3; i++) knob(0, +3);   /* 9 detents: more than one option */
flush();
check("a knob turn after the pad continues from the PAD's value",
      ui.__test.ui.slots[0].channel > 8,
      "channel is " + ui.__test.ui.slots[0].channel + ", want above the pad's 8");

/* ---------------------------------------------------------------- picker
 *
 * Touch a knob, click the jog. Driven through the REAL MIDI entry point, not
 * through an opener exported for the test: the whole feature is a question of
 * DISPATCH ORDER, and a helper that skips the dispatch cannot answer it.
 */
ui.__test.showPage(setupIdx);
eq("Setup knob 2 -> direction", ui.keyForKnob(1), "direction");
eq("Setup knob 1 -> channel",   ui.keyForKnob(0), "channel");

/*
 * TURNING A KNOB CLAIMS IT, so "nothing is held" has to mean it.
 *
 * The controller's `touched` follows a TURN as well as a touch -- a knob can
 * be moved without the capacitive pad ever registering, and the header has to
 * follow the one you are working on. The claim expires on its own
 * (TURN_CLAIM_MS), but the tests above have just spun two knobs, so it is
 * cleared explicitly rather than being waited out.
 */
ui.__test.ctl.clearTouch();
check("nothing is held, so a click opens nothing",
      (click(), ui.__test.picker() === null));

/* A DIVABLE key opens it. */
ui.__test.ui.slots[0].direction = 0;
ui.__test.noteExternalChange("direction");
touch(1); click();
let pk = ui.__test.picker();
check("holding Direction and clicking opens the picker", pk !== null);
eq("...on the right key", pk && pk.key, "direction");
eq("...with the declared options", pk && pk.options.join(","), "Fwd,Rev,Ping,Rnd");
check("...and they are the SHARED meta's options, not a local list",
      pk && pk.options.join(",") ===
          (ui.__test.metaFor("direction").options || []).join(","));
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

/* The picker commits through `ctl.commitEnum`, so the value on the wire is the
 * option TEXT and the slot gets the number out of it -- not an index, which on
 * this enum would have landed one channel short. */
ui.__test.ui.slots[0].channel = 1;
ui.__test.noteExternalChange("channel");
touch(0); click();
check("holding MIDI Ch and clicking opens the picker", ui.__test.picker() !== null);
jog(9);
writes.length = 0;
click();
eq("the picker commits the CHOSEN channel", ui.__test.ui.slots[0].channel, 10);
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
if (ui.__test.pageIndex[0] < 0) ui.__test.showPage(setupIdx);
{
    const cutMeta = ui.__test.metaFor("303.cutoff");
    check("303.cutoff is NOT divable", !META_isDivable(cutMeta));
}
ui.__test.showPage(setupIdx);
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

/*
 * THE TWO INDICES STAY ONE-TO-ONE, on every outer page.
 *
 * `syncController` is the single function that moves them together, and this
 * walks every outer page through it: the controller must land exactly where
 * `controllerPageFor` says, and must not move at all on Pads or Keys.
 */
{
    const { controllerPageFor } = await import("../src/params.mjs");
    const set = ui.pages();
    for (let i = 0; i < set.length; i++) {
        const before = ui.__test.ctl.pageIndex;
        ui.__test.showPage(i);
        const want = controllerPageFor(set, i);
        if (want >= 0) {
            eq("outer " + set[i].name + " parks the controller on " + want,
               ui.__test.ctl.pageIndex, want);
        } else {
            eq("outer " + set[i].name + " moves the controller nowhere",
               ui.__test.ctl.pageIndex, before);
        }
    }
    ui.__test.showPage(0);
}

/* ---------------------------------------------------------- slot A/B
 *
 * TWO SEQUENCERS BEHIND THE SAME KEYS. `dspValues` was recomputed on every
 * draw, so switching slots was free; the controller CACHES its values, so a
 * switch that forgot to invalidate them would show slot A's channel on slot B
 * -- and go on showing it, because nothing about the KEY changed.
 */
ui.__test.ui.slots[0].channel = 3;
ui.__test.ui.slots[1].channel = 12;
ui.__test.ui.activeSlot = 0;
ui.__test.showPage(setupIdx);
ui.__test.ctl.state.values.channel = ui.__test.getParam("channel");
eq("slot A shows its own channel", ui.__test.ctl.state.values.channel, "Ch 3");
midi(0xB0, 41, 127);                 /* Track 3 = slot B, Pattern */
eq("...and T3 switched to slot B", ui.__test.ui.activeSlot, 1);
eq("the grid followed the slot, not the key",
   ui.__test.ctl.state.values.channel, "Ch 12");
midi(0xB0, 43, 127);                 /* Track 1 = back to slot A */
eq("...and back again", ui.__test.ctl.state.values.channel, "Ch 3");

/* ------------------------------------------------- the 303 page appears
 *
 * The 303 page is a LEVEL in the contract, so a 303 arriving changes the
 * contract's SHAPE -- the controller has to be re-planned, or the outer page
 * set grows to six while the controller still has two knob pages and every
 * index behind the 303 names the wrong one.
 */
{
    eq("no 303: the contract plans 2 knob pages", ui.__test.ctl.pages.length, 2);
    globalThis.shadow_get_param = (slot) => (slot === 0 ? "303" : "");
    for (let i = 0; i < 70; i++) globalThis.tick();
    eq("a 303 appearing gives 6 outer pages", ui.pages().length, 6);
    eq("...and 3 planned knob pages", ui.__test.ctl.pages.length, 3);
    ui.__test.showPage(ui.pages().findIndex((p) => p.name === "303"));
    eq("...whose knob 1 is the 303's cutoff", ui.keyForKnob(0), "303.cutoff");
    globalThis.shadow_get_param = () => "";
    for (let i = 0; i < 70; i++) globalThis.tick();
    eq("a 303 leaving gives 5 outer pages again", ui.pages().length, 5);
    eq("...and 2 planned knob pages", ui.__test.ctl.pages.length, 2);
    check("...and the page landed on is a real one",
          ui.__test.ctl.pageIndex < ui.__test.ctl.pages.length);
}

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

/*
 * Page navigation CAPS at both ends rather than wrapping.
 *
 * Wrapping hides the ends: nothing says the page set stopped, so you have to
 * read the bank bar to know where you are. It is also what page_nav.mjs
 * `step()` does for every other screen on the device, so wrapping was TB-3PO
 * disagreeing with the rest of the device rather than a house style.
 *
 * Driven through the REAL jog message, not a helper: CC 14, where a value of
 * 1 is one detent clockwise and 127 is one anticlockwise.
 */
{
    const n = ui.pages().length;
    const jog = (dir) => midi(0xB0, 14, dir > 0 ? 1 : 127);

    ui.__test.pageIndex[0] = n - 1;
    jog(+1);
    check("jog past the last page stays put", ui.__test.pageIndex[0] === n - 1,
          "index " + ui.__test.pageIndex[0] + " of " + n);

    ui.__test.pageIndex[0] = 0;
    jog(-1);
    check("jog before the first page stays put", ui.__test.pageIndex[0] === 0,
          "index " + ui.__test.pageIndex[0]);

    ui.__test.pageIndex[0] = 0;
    jog(+1);
    check("jog still advances in the middle", ui.__test.pageIndex[0] === 1,
          "index " + ui.__test.pageIndex[0]);

    ui.__test.pageIndex[0] = 0;
}

console.log(failures === 0 ? "ui_smoke: all passed" : "ui_smoke: " + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
