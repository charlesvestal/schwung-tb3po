# TB-3PO Dual-Slot Design

Date: 2026-04-22

## Goal

One TB-3PO module instance controls **two** external 303s in parallel. Each
"slot" (A, B) has its own sequencer pattern and its own 303 Control state,
sends on its own MIDI channel (defaults: A=1, B=2), and runs simultaneously
clock-synced to the Move transport. The user sees/edits one slot at a time;
track buttons select which.

## Track button mapping

| Button    | Slot | Mode        | LED (active) |
|-----------|------|-------------|--------------|
| T1 (CC43) | A    | 3PO         | Teal         |
| T2 (CC42) | A    | 303 Control | Orange       |
| T3 (CC41) | B    | 3PO         | Teal         |
| T4 (CC40) | B    | 303 Control | Orange       |

Only one button is lit bright at a time (the active slot+mode). The other
three are dim. T2/T4 stay dark when no 303 hardware is detected (extends the
existing `has303Slot` gating). Pressing a track button sets
`(activeSlot, controlMode)` in one action and remembers per-slot "last mode"
so pressing T1 after T4 lands on Slot A's last mode.

## State model

```
ui = {
    activeSlot: 0,                 // 0 = A, 1 = B
    slots: [slotA, slotB],
    // shared UI state (overlays, LED refresh, etc.)
}

slot = {
    mode: MODE_3PO,                // last-used mode for this slot
    channel: 1,                    // 1 for A, 2 for B by default

    // sequencer
    pattern: { notes, accents, slides, gates, length },
    density, accent, slide, octaves, gate,
    scale, root,
    seed,
    stepPage: 0,

    // 303 Control cache (per-CC values for display / soft-takeover)
    cc303: { ... },

    // jog menu state
    menuState: { [pageId]: { selectedIndex, editing } },

    // undo buffer
    undoStack: [...],
}
```

Shared (global): transport/clock, overlay text, LED force-refresh flag,
module settings that aren't slot-specific.

## UI behavior

- Switching slot redraws the step grid, knob/overlay values, and current page
  from the incoming slot's state.
- Jog edit flag is per-slot — an in-progress edit on the slot you leave is
  preserved.
- Destructive/editing actions (Shift+CLEAR, Undo, Regenerate, Mutate, step
  taps, octave ±, step-page left/right) are **active-slot only**.
- Transport (Play) is global — both slots' sequencers run together.

## DSP engine

Single clock, two sequencer state blocks. On each clock tick, both slots
advance their own cursors (each wraps at its own `length`) and emit note
on/off on their own MIDI channel. Transport restart zeroes both cursors.

### Param routing JS ↔ DSP

Namespace per slot. Instead of `setDspParam("density", v)`:

- `setDspParam("a.density", v)` — Slot A
- `setDspParam("b.density", v)` — Slot B

Plus one shared param:

- `setDspParam("active_slot", 0|1)` — tells DSP which channel outgoing CCs
  from the 303 Control knob path should ride.

Pattern/grid params (note/accent/slide/gate arrays and length) get the same
`a.*` / `b.*` prefix treatment.

### 303 Control mode routing

Knobs turned on the active slot send CCs on that slot's channel (via
`active_slot` indirection). The other slot's cached CCs are untouched until
you switch to it; on switch, knob overlays re-read from that slot's cache.

### What stays unchanged

Clock source, overtake handling, jog-wheel delta/detent code,
Play-button passthrough, step-grid rendering engine. All of these operate on
whatever slot is currently active.

## Persistence

Disk format bumps to `version: 2`:

```
{
    "version": 2,
    "activeSlot": 0,
    "slots": [slotA, slotB],
    "shared": { ... }
}
```

One-shot migration for v1: load old flat state into `slots[0]`, initialise
`slots[1]` with defaults (channel=2), `activeSlot=0`. No v1 writer kept.

## Risks / watch-outs

- **Same-channel collision.** Nothing prevents the user setting both slots to
  ch 1; notes collide. Not our problem to solve beyond defaults; optionally a
  one-line hint on the channel page.
- **CPU doubling.** Two sequencers tick every pulse. Sequencer is cheap but
  worth a quick measurement after the DSP change.
- **State bloat.** 2 × (64-step pattern + knob state). Still tiny.
- **Button LED budget.** T3/T4 now carry meaning. Verify no host/shadow-UI
  code assumes they stay dark for this module.

## YAGNI — explicitly NOT doing

- Copy pattern A→B.
- Parameter linking across slots.
- Shared scale/root across slots.
- Phase offsets between slots.
- Separate transport per slot.
- Channel-collision warning UI.

## Implementation order

1. Refactor `ui.*` flat fields into `ui.slots[i]` with an `activeSlot`
   indirection. Single slot still — no behavior change. Verify on hardware.
2. Add Slot B defaults, T3/T4 button handlers, LED updates for four buttons.
   Slot switching live but DSP still single-voice.
3. DSP: duplicate sequencer state block, adopt `a.*` / `b.*` param namespace,
   emit note on/off per slot on its own channel.
4. 303 Control CC path: route via `active_slot`, cache CCs per slot, re-read
   overlays on slot switch.
5. Persist v2, migrate v1.
6. Version bump + release (keep `release.json` pinned until ready to ship).
