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
/* Every string the last frame printed. The peek and the picker are drawn with
 * drawEnumList, whose OPTION ROWS go through print() -- so this is how a test
 * with no framebuffer can tell "the overlay was drawn" from "the overlay was
 * merely raised". The header band and the footer are font4x5 fillRect glyphs
 * and cannot be read back at all, which is why the assertions below are about
 * the list rows. */
const printed = [];
const leds = [];
Object.assign(globalThis, {
    print: (x, y, text) => { printed.push(String(text)); },
    fill_rect: () => {},
    draw_rect: () => {},
    draw_line: () => {},
    /* menu_layout's scrollbar draws pixel by pixel, and a list long enough to
     * need one (Ch 1..16) is exactly what the peek and the picker raise. */
    set_pixel: () => {},
    text_width: (s) => String(s).length * 6,
    clear_screen: () => {},
    host_module_set_param: (k, v) => { writes.push([k, v]); },
    host_module_get_param: () => "",
    shadow_get_param: () => "",
    /* refreshLeds runs on the same tick as draw(); the shared LED helpers
     * write through this one. */
    /* Every LED packet the frame emitted: [cable/CIN, status, d1, d2]. The
     * knob rings are CC 71-78 out, the same CCs the encoders come in on. */
    move_midi_internal_send: (pkt) => { leds.push(Array.from(pkt)); return true; },
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
 * not a picker.
 *
 * This used transpose as its second example until transpose became an enum of
 * octaves; the knob is on the 303 page now, which is where the plain ints
 * actually live.
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
{
    /* The channel test above leaves its picker open; a second click is how it
     * closes, and a leaked layer would make everything below it meaningless. */
    if (ui.__test.picker()) click();
    check("the channel picker closed before this block", ui.__test.picker() === null);
    /* Pattern knob 8 = octaves, an int 1..3. Deliberately NOT 303.cutoff:
     * this stub has no 303 plugin, so that page is absent from the set and a
     * touch meant for it lands on whatever page is showing instead -- which
     * is how this assertion first passed against Setup's channel. */
    ui.__test.showPage(r.findIndex((p) => p.name === "Pattern"));
    touch(7);
    click();
    check("holding a plain int and clicking opens nothing", ui.__test.picker() === null);
    untouch(7);
    ui.__test.showPage(setupIdx);
}

/* And transpose, now an enum of octaves, DOES open -- the same click on the
 * same physical knob, which is the point of declaring it in the unit its
 * label promises. */
touch(2);
click();
check("transpose opens a picker of octaves", !!ui.__test.picker());
eq("...listing nine", ui.__test.picker() && ui.__test.picker().options.length, 9);
eq("...labelled in octaves", ui.__test.picker() && ui.__test.picker().options[4], "0 oct");
if (ui.__test.picker()) click();
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

/* ============ THE REST OF THE BINDING ============
 *
 * The controller RAISES things it does not draw and REFUSES input it does not
 * claim; the host draws and routes the rest. TB-3PO adopted the state without
 * that half, and these are the three defects it cost, each driven through the
 * real MIDI entry point.
 */

/* ---------------------------------------------------------- the enum peek */
{
    ui.__test.showPage(setupIdx);
    ui.__test.ctl.clearTouch();
    ui.__test.ui.slots[0].channel = 1;
    ui.__test.noteExternalChange("channel");

    /* Setup knob 1 is MIDI Ch: a divable enum of 16, which is what peeks. */
    knob(0, +4);
    const peek = ui.__test.ctl.enumPeek();
    check("turning a divable enum RAISES the peek", !!peek,
          "enumPeek() was " + JSON.stringify(peek));
    eq("...on the key that was turned", peek && peek.key, "channel");

    /*
     * ...AND THE FRAME DRAWS IT. The controller only computes the peek — the
     * host is what puts it on screen — so "it was raised" is exactly the half
     * TB-3PO already had. Asserted as THREE consecutive options in one frame:
     * a single grid cell can print the live value, so one option proves
     * nothing, and no cell can print a list.
     */
    printed.length = 0;
    globalThis.tick();
    const rows = ["Ch 1", "Ch 2", "Ch 3"].filter((o) => printed.indexOf(o) >= 0);
    check("...and the frame DRAWS its option list", rows.length === 3,
          "printed " + JSON.stringify(printed));

    /* A page with no peek up must not be drawing one — otherwise the check
     * above would pass on a screen that always showed the list. */
    ui.__test.ctl.dismissPeek();
    printed.length = 0;
    globalThis.tick();
    check("...and nothing draws it once it is down",
          ["Ch 1", "Ch 2", "Ch 3"].filter((o) => printed.indexOf(o) >= 0).length < 3,
          "printed " + JSON.stringify(printed));
}

/* -------------------------------------------- a knob scrolls the picker */
{
    ui.__test.showPage(setupIdx);
    ui.__test.ctl.clearTouch();
    ui.__test.ui.slots[0].channel = 1;
    ui.__test.noteExternalChange("channel");
    touch(0); click();
    check("MIDI Ch opens the picker", ui.__test.picker() !== null);
    eq("...at the live option", ui.__test.picker().index, 0);

    /*
     * 30 detents, and the answer is 5 — NOT 30, and not 0.
     *
     * The hand is still on the knob that opened the list, so a turn has to
     * reach it (it used to fall through and edit the param BEHIND the list).
     * Through listKnobStep, though: DETENTS_PER_ENTRY is 6 and a 16-option
     * list is too short to accelerate, so this pins both halves at once — 0
     * would mean the knob is dead, 15 (the clamp) would mean 1:1.
     */
    writes.length = 0;
    knob(0, +30);
    eq("a knob scrolls the picker through the LIST accumulator",
       ui.__test.picker().index, 5);
    eq("...and writes nothing while it scrolls", writes.length, 0);

    /* Pads and the jog still behave as they did. */
    click();
    check("a click still commits", ui.__test.picker() === null);
    eq("...the option the knob landed on", ui.__test.ui.slots[0].channel, 6);
    untouch(0);
}

/* ------------------------------------------------------- Back is a ladder */
{
    /*
     * THE CAPABILITY IS THE FIX. Without `suspend_self_managed` shadow_ui.js
     * turns a plain Back into suspendOvertakeMode() before onMidiMessageInternal
     * runs, so none of the layering below is reachable on hardware however
     * correct it is here. Asserted against the shipped manifest, not against a
     * copy of it.
     */
    const fs = await import("node:fs");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(path.join(here, "../src/module.json"), "utf8"));
    check("module.json claims suspend_self_managed",
          manifest.capabilities && manifest.capabilities.suspend_self_managed === true,
          "capabilities were " + JSON.stringify(manifest.capabilities));

    let suspends = 0;
    globalThis.host_suspend_overtake = () => { suspends++; };
    const back = () => midi(0xB0, 51, 127);

    ui.__test.showPage(setupIdx);
    ui.__test.ctl.clearTouch();

    /* Layer 1: the peek. This is the reported bug — "if i hit back during
     * autopeek it exits the module". */
    knob(0, +4);
    check("the peek is up", !!ui.__test.ctl.enumPeek());
    back();
    check("Back takes the peek down", !ui.__test.ctl.enumPeek());
    eq("...and does NOT park the tool", suspends, 0);

    /* Layer 2: the picker, cancelled rather than committed. */
    ui.__test.ctl.clearTouch();
    ui.__test.ui.slots[0].channel = 4;
    ui.__test.noteExternalChange("channel");
    touch(0); click();
    check("the picker is up", ui.__test.picker() !== null);
    jog(3);
    writes.length = 0;
    back();
    check("Back closes the picker", ui.__test.picker() === null);
    eq("...without committing", ui.__test.ui.slots[0].channel, 4);
    eq("...and still does not park the tool", suspends, 0);
    untouch(0);

    /* Layer 3: nothing is up, so Back is the park the host used to do for us. */
    ui.__test.ctl.clearTouch();
    ui.__test.ctl.dismissPeek();
    back();
    eq("Back with no layer up parks the tool", suspends, 1);
    /* The release edge is not a second press. */
    midi(0xB0, 51, 0);
    eq("...once, on the press edge only", suspends, 1);
}

/* ------------------------------------------------- the knob indicator rings */
{
    /* The host lights CC 71-78 from the values the controller already holds,
     * on a knob page and nowhere else -- nothing on this screen otherwise says
     * which physical encoder drives which drawn cell. TB-3PO drew the grid and
     * left the rings dark. */
    const ringsIn = (frame) => frame.filter((p) => p[2] >= 71 && p[2] <= 78);
    const lit = (frame) => ringsIn(frame).filter((p) => p[3] !== 0);

    ui.__test.showPage(setupIdx);
    ui.__test.ctl.clearTouch();
    /* Two frames: the first emits, the second is suppressed by the diff cache
     * -- so the assertion is about the FIRST, and the second proves the cache
     * is doing its job rather than eight packets going out every tick. */
    leds.length = 0;
    globalThis.tick();
    const firstRings = ringsIn(leds);
    check("a knob page lights the indicator rings", lit(leds).length > 0,
          "ring packets were " + JSON.stringify(firstRings));
    leds.length = 0;
    globalThis.tick();
    eq("...and an unchanged page re-sends none of them", ringsIn(leds).length, 0);

    /* Pads has no cells, so every ring goes dark -- a lit knob there would say
     * eight controls do something when none of them does. */
    ui.__test.showPage(r.findIndex((p) => p.name === "Pads"));
    leds.length = 0;
    globalThis.tick();
    const dark = ringsIn(leds);
    check("...and Pads darkens every one that was lit",
          dark.length > 0 && dark.every((p) => p[3] === 0),
          "ring packets were " + JSON.stringify(dark));
    ui.__test.showPage(setupIdx);
}

console.log(failures === 0 ? "ui_smoke: all passed" : "ui_smoke: " + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
