# Dual-Slot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend TB-3PO so one module instance hosts two parallel 303 worlds
(slots A and B), each with its own sequencer pattern, 303 Control state, and
MIDI channel. Track buttons T1–T4 select `(slot, mode)`.

**Architecture:** State refactor in `src/ui.js` into `ui.slots[0..1]` +
`activeSlot`; DSP in `src/dsp/tb3po.c` grows a second sequencer state block
driven by the same clock, with params namespaced `a.*` / `b.*` and a shared
`active_slot` param for CC routing.

**Tech Stack:** Move module (JS UI + C DSP, built via Docker), no automated
test framework — verification is build/install + hardware sanity checks after
every task.

**Design doc:** `docs/plans/2026-04-22-dual-slot-design.md`

**Verification rule for every task:** `./scripts/build.sh &&
./scripts/install.sh` must succeed; load TB-3PO on Move and confirm the task's
acceptance criteria on hardware before committing.

---

## Task 1: JS state refactor — introduce `slots[]` with no behavior change

**Files:**
- Modify: `src/ui.js`

**Step 1: Add slot factory + array at the top of the file**

Replace the flat `let ui = { ... }` block (ui.js:81-101) with:

```js
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
    slots: [makeSlot()],   // slot B added in Task 3
    bpm: 120,              // global
    running: 1,            // global
    syncSource: "INT"      // global
};

function cur() { return ui.slots[ui.activeSlot]; }
```

Delete the standalone `cc303Values`, `menuState`, `controlMode`, and
`stepView` globals — they move into the slot.

**Step 2: Rewrite every `ui.<field>` reference to use `cur()`**

Mechanical sweep. Examples:
- `ui.length` → `cur().length`
- `ui.steps[i]` → `cur().steps[i]`
- `ui.position` → `cur().position`
- `controlMode` → `cur().mode`
- `menuState[p]` → `cur().menuState[p]`
- `cc303Values[i]` → `cur().cc303[i]`
- `stepView` → `cur().stepView`

Keep global reads (`ui.bpm`, `ui.running`, `ui.syncSource`) unchanged.

Run a search for `ui\.` and audit every hit. Don't miss `stepPageCount()`,
`clampStepView()`, `parsePattern()`, `pollDsp()`, `drawPerformPage()`,
`drawMutationPage()`, `drawScalePage()`, `drawChannelPage()`, `refreshLeds()`,
`handlePadNoteOn()`, `send303Cc()`, and the knob/jog path.

**Step 3: Build + install**

```
./scripts/build.sh && ./scripts/install.sh
```

Expect: build succeeds. Module loads. Identical behavior to pre-refactor —
sequencer plays, 303 Control works, banks save/recall, jog menu edits work,
LEDs match what they did before.

**Step 4: Commit**

```
git add src/ui.js
git commit -m "ui: fold flat state into slots[0] (no behavior change)"
```

---

## Task 2: DSP param namespace — prefix all per-slot params with `a.`

**Files:**
- Modify: `src/dsp/tb3po.c`
- Modify: `src/ui.js`

**Step 1: Enumerate per-slot params in DSP**

Read `src/dsp/tb3po.c` and list every `set_param`/`get_param` name that's
per-slot (density, accent, slide, octaves, root, scale, length, gate,
channel, direction, transpose, pattern, set_step, generate, mutate, clear,
store_bank, recall_bank, recall_bank_now, undo, seed, position, bank_filled,
current_bank, pending_recall, steps). Global params stay unprefixed (bpm,
running, sync_source).

**Step 2: Add `a.` prefix routing in DSP**

In DSP's `set_param` / `get_param` dispatch, accept both forms during the
migration but prefer `a.`. Implementation: strip `a.` prefix at entry and
route to slot-A state. Later tasks add `b.`.

**Step 3: Update all JS call sites**

Every `setDspParam("density", ...)` → `setDspParam("a.density", ...)`.
Every `getDspParam("position")` → `getDspParam("a.position")` etc.
Use a helper:

```js
function slotKey(k) { return (ui.activeSlot === 0 ? "a." : "b.") + k; }
// ...
setDspParam(slotKey("density"), ...);
getDspParam(slotKey("position"));
```

Globals (`bpm`, `running`, `sync_source`) keep the bare name.

**Step 4: Build + install + hardware test**

Expect: identical behavior to Task 1. Every sequencer param still responds.
Bank save/recall still works. 303 Control mode still works.

**Step 5: Commit**

```
git add src/ui.js src/dsp/tb3po.c
git commit -m "dsp: namespace per-slot params with a.* prefix"
```

---

## Task 3: Add Slot B state + T3/T4 button wiring (Slot B silent for now)

**Files:**
- Modify: `src/ui.js`
- Modify: `src/dsp/tb3po.c`

**Step 1: Second slot in JS**

Change `slots: [makeSlot()]` to `slots: [makeSlot(), makeSlot({channel: 2})]`.

**Step 2: Add T3/T4 CCs**

At the top of `src/ui.js`:
```js
const CC_TRACK3 = 41;
const CC_TRACK4 = 40;
```

**Step 3: Rework track-button handler**

Replace the existing T1/T2 handler block (ui.js:974-992) with a unified
handler that sets both `activeSlot` and `mode`:

```js
function selectSlotMode(slotIdx, mode) {
    if (mode === MODE_303) {
        cc303SlotIdx = find303Slot();
        has303Slot = cc303SlotIdx >= 0;
        if (!has303Slot) {
            showOverlay("No 303 loaded", "route a 303 to Ch" + ui.slots[slotIdx].channel);
            return;
        }
    }
    ui.activeSlot = slotIdx;
    ui.slots[slotIdx].mode = mode;
    setDspParam("active_slot", String(slotIdx));
    if (mode === MODE_303) sync303FromPlugin();
    showOverlay("Slot " + (slotIdx === 0 ? "A" : "B"),
                 mode === MODE_3PO ? "3PO" : "303 CCs");
}

// Replace the four CC_TRACK{1..4} branches:
if (type === 0xB0 && d2 > 0) {
    if      (d1 === CC_TRACK1) { selectSlotMode(0, MODE_3PO); return; }
    else if (d1 === CC_TRACK2) { selectSlotMode(0, MODE_303); return; }
    else if (d1 === CC_TRACK3) { selectSlotMode(1, MODE_3PO); return; }
    else if (d1 === CC_TRACK4) { selectSlotMode(1, MODE_303); return; }
}
```

**Step 4: LED update for four track buttons**

In `refreshLeds()` replace the T1/T2 block (ui.js:690-695) with:

```js
function trackLed(slotIdx, mode) {
    const active = (ui.activeSlot === slotIdx && cur().mode === mode);
    if (mode === MODE_303 && !has303Slot) return LED_OFF;
    if (!active) return LED_DARK_GREY;
    return mode === MODE_3PO ? LED_TEAL : LED_ORANGE;
}
setTrackLed(CC_TRACK1, trackLed(0, MODE_3PO));
setTrackLed(CC_TRACK2, trackLed(0, MODE_303));
setTrackLed(CC_TRACK3, trackLed(1, MODE_3PO));
setTrackLed(CC_TRACK4, trackLed(1, MODE_303));
```

**Step 5: DSP — add slot B state block (still silent)**

In `src/dsp/tb3po.c`, duplicate the sequencer state struct into an array of
2, routed via `a.` / `b.` prefixes. Slot B's sequencer advances on clock
ticks with its own cursor but **does not emit MIDI yet** — leave a TODO at
the emission path for Task 4. Add `active_slot` as a globally-scoped param.

**Step 6: Overlay hint**

On `selectSlotMode`, the overlay already shows which slot is active. Also
add a one-time first-load nudge in `init`:
```js
showOverlay("Slots A+B", "T1/T2 A, T3/T4 B", 360);
```
Replace the existing first-load nudge.

**Step 7: Build + install + hardware verify**

- T1 lit teal → Slot A, 3PO. Play plays Slot A.
- T2 lit orange → Slot A, 303 Control. Knobs send CCs on Slot A's channel.
- T3 → Slot B view (empty pattern initially). Slot B still silent (expected).
- T4 → Slot B, 303 Control (needs 303 present).
- Switching slots preserves each slot's jog-menu edit state and step-page
  position.

**Step 8: Commit**

```
git add src/ui.js src/dsp/tb3po.c
git commit -m "dual-slot: add slot B state, T3/T4 buttons (B still silent)"
```

---

## Task 4: Slot B MIDI emission — both sequencers play in parallel

**Files:**
- Modify: `src/dsp/tb3po.c`

**Step 1: Enable per-slot note emission**

In DSP's clock-tick handler, loop over both slots. Each slot emits note on/off
on its own `channel` param. Remove the "slot B silent" TODO.

**Step 2: Shared-transport behavior**

Both slots reset cursor to 0 on transport start. Each wraps at its own
`length`. If running is false, no emission for either.

**Step 3: Build + install + hardware test**

- With Slot A pattern loaded on ch1 routed to 303 #1, Slot B pattern on ch2
  routed to 303 #2 (or another synth for testing), press Play: both play in
  sync, each on its own channel.
- Regenerate Slot A → Slot B pattern unchanged.
- CLEAR on Slot A → Slot B pattern unchanged.
- Same-channel collision test: set both to ch1, confirm notes collide (expected).

**Step 4: Commit**

```
git add src/dsp/tb3po.c
git commit -m "dsp: emit notes for both slots on their own channels"
```

---

## Task 5: 303 Control CC path per-slot channel

**Files:**
- Modify: `src/ui.js`

**Step 1: CC routing uses active slot's channel**

In `send303Cc` (ui.js:495), replace `ui.channel` with `cur().channel` (already
implicit after Task 1 refactor, but audit and confirm).

**Step 2: CC cache per slot**

`cur().cc303` already exists per slot after Task 1. Confirm every reader
(`knobOverlayInfo`, `drawMutationPage` 303 branch, `drawScalePage` 303 branch,
`sync303FromPlugin`) reads from `cur().cc303`, not the old flat array.

**Step 3: Re-sync on slot switch**

On `selectSlotMode(_, MODE_303)`, `sync303FromPlugin()` writes into
`cur().cc303` — verify. The other slot's cache is untouched.

**Step 4: Build + install + hardware test**

- Slot A 303 on ch1 to 303 #1, Slot B 303 on ch2 to 303 #2.
- Turn knob in Slot A 303 mode → 303 #1 responds, 303 #2 unchanged.
- Switch to Slot B, turn same knob → 303 #2 responds, 303 #1 unchanged.
- Switch back to Slot A, knob overlay shows Slot A's remembered value.

**Step 5: Commit**

```
git add src/ui.js
git commit -m "303 control: route CC on active slot's channel and cache"
```

---

## Task 6: Persistence v2 + migration from v1

**Files:**
- Modify: `src/dsp/tb3po.c`

**Step 1: Bump save format version**

Find the DSP persistence code (commit 3d9607c introduced it). Bump the
on-disk version marker to 2. Serialize:
```
{ version: 2, activeSlot, slots: [slotA, slotB], shared: {...} }
```

**Step 2: Migration**

Reader: if file's version is 1, load flat fields into `slots[0]`, initialise
`slots[1]` with defaults (channel=2), `activeSlot=0`, write v2 back on next
save. If file absent, cold-start both slots from defaults.

**Step 3: Build + install + hardware test**

- Starting from a device that already has v0.2.2 state on disk: load v0.2.3
  (or whatever this becomes), verify Slot A matches previous pattern and
  Slot B is empty on ch2.
- Save + reload → both slots persist through restart.

**Step 4: Commit**

```
git add src/dsp/tb3po.c
git commit -m "dsp: persist v2 format (two slots) with v1 migration"
```

---

## Task 7: Version bump + release (release.json stays pinned)

**Files:**
- Modify: `src/module.json`

**Step 1: Bump version**

`src/module.json` version → `0.3.0` (minor bump — new feature).

**Step 2: Commit, tag, push, add release notes**

```
git add src/module.json
git commit -m "v0.3.0: dual-slot mode (two 303 worlds in one module)"
git push
git tag v0.3.0 && git push origin v0.3.0
```

After the workflow completes:

```
gh release edit v0.3.0 --notes "$(cat <<'EOF'
- One TB-3PO instance now hosts two independent slots (A and B), each with
  its own sequencer pattern, 303 Control state, and MIDI channel. Both run
  in parallel, clock-synced to Move transport.
- Track buttons: T1=Slot A 3PO, T2=Slot A 303, T3=Slot B 3PO, T4=Slot B 303.
  Defaults: Slot A ch 1, Slot B ch 2.
- Persistence format bumped to v2 with one-shot v1 migration.
EOF
)"
```

**Step 3: Revert release.json auto-bump so the Module Store doesn't ship yet**

```
git pull
# Edit release.json version back to the current shipping version.
git add release.json
git commit -m "release.json: keep pinned until ready to ship v0.3.0"
git push
```

---

## Notes for the executor

- **No automated tests exist.** Verification is manual hardware sanity after
  every task. Do not skip it — this is how we find regressions.
- **Don't refactor beyond what each task requires.** Keep changes tight.
- **DSP state struct**: the cleanest refactor is a `SlotState slots[2]` with
  most of the current top-level sequencer globals moved in. A quick first
  pass can use a pointer `active` that points to `slots[0]` during tick, but
  for two-slot emission Task 4 must loop over both.
- **Param dispatch in DSP**: strip the `a.`/`b.` prefix at the top of
  `set_param` and `get_param`, pick the slot index, delegate to a
  slot-scoped handler. Keeps the per-slot handler oblivious to slot index.
- **Jog wheel and detent code stays exactly as-is.** Task 1 just rehomes
  its state into the active slot.
