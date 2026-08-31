# TB-3PO — Generative Acid Bassline Sequencer for Schwung

A JS-only module for [Schwung](https://github.com/charlesvestal/schwung) that ports the [Phazerville Hemisphere Suite](https://github.com/djphazer/O_C-Phazerville) `TB_3PO` applet to Move hardware. Generates 303-style patterns with density / accent / slide probabilities, scale-locked notes, pattern banks, mutate, and multiple playback directions.

Two independent slots (A and B) run in parallel, each with its own pattern, MIDI channel, and bank set. Pair each slot in a shadow slot with a resonant monosynth ([schwung-303](https://github.com/charlesvestal/schwung-303), Bristol, OB-Xd, Raffo Moog, …) — TB-3PO emits MIDI only; the squelch comes from your synth.

## Install

From the Schwung Module Store, or manually:

```bash
git clone https://github.com/charlesvestal/schwung-tb3po
cd schwung-tb3po
./scripts/build.sh && ./scripts/install.sh
```

Requires Schwung **v0.9.8 or later** (needs the `suspend_keeps_js` capability).

## Usage

1. Open **Tools** (Shift+Vol+Step13) → pick **TB-3PO**.
2. Set the MIDI channel for slot A on the **CHANNEL** page (Step button 4). Switch to slot B with **T3** and set its channel.
3. Load synths into shadow slots and set their `receive_channel` to match. For the easiest path, pair with [schwung-303](https://github.com/charlesvestal/schwung-303) on each channel.
4. **Back** → close an open list, or suspend (both slots keep sequencing while you play Move).
5. **Shift+Back** → full exit.
6. Re-open from Tools menu → resumes with patterns + position intact.

## Slots & Modes

Track buttons select which slot is active and what the 8 front-panel knobs do:

| Button | Slot | Mode | Knobs control |
|---|---|---|---|
| T1 | A | 3PO | sequencer params (density / accent / slide / oct / root / scale / length / gate) |
| T2 | A | 303 | live CCs to a schwung-303 on slot A's channel |
| T3 | B | 3PO | sequencer params for slot B |
| T4 | B | 303 | live CCs to a schwung-303 on slot B's channel |

Both slots sequence at all times — the buttons just switch which slot the knobs and pads edit. Active slot/mode lights bright (teal = 3PO, orange = 303). 303-mode buttons are dark unless a `303` plugin is reachable in some shadow slot.

## Pages (Step buttons 1–5)

1. **PERFORM** — header, step grid, pattern info
2. **MUTATION** — jog-edit Density / Accent / Slide / Octaves (or **303 Control 1** in 303 mode: live K1–K4 readouts)
3. **SCALE** — jog-edit Root / Scale / Length / Gate (or **303 Control 2** in 303 mode: live K5–K8 readouts)
4. **CHANNEL** — jog-edit MIDI out channel (1–16) for the active slot
5. **HELP** — on-screen pad map

### Option lists

Hold a knob whose cell is an enum (MIDI Ch, Direction, Root, Scale, Length) and click the jog: its options open full-screen. The jog **or the knob still under your hand** scrolls, a click sets, **Back cancels**. Simply *turning* such a knob raises the same list for about 0.7 s — a read-out of where you have landed, not a question, so there is nothing to cancel and Back just takes it down.

## Knobs — 303 mode (CC controller)

When in 303 mode, the 8 knobs send standard 303-style CCs to the loaded `303` plugin on the active slot's channel:

| Knob | Param | CC |
|---:|---|---:|
| 1 | Cutoff | 74 |
| 2 | Resonance | 71 |
| 3 | Decay | 75 |
| 4 | Env Mod | 70 |
| 5 | Accent | 16 |
| 6 | Volume | 7 |
| 7 | Drive | 12 |
| 8 | Drive Mix | 13 |

On entering 303 mode, knob state syncs from the plugin's current values so the first turn doesn't jump.

## Pads (4 rows, top = row 3)

- **Row 3** — steps 1–8 of the current step page
- **Row 2** — steps 9–16 of the current step page
  Tap cycles **rest → note → accent → slide**.
- **Row 1** — pattern banks 1–8.
  Tap = recall (queued to next bar if playing). **Shift+tap** = save current to bank.
- **Row 0** — actions:

| Pad | Action |
|---:|---|
| 1 | **NEW** — regenerate pattern from a fresh seed |
| 2 | **MUT** — nudge ~25% of existing steps |
| 3 | **DIR** — cycle Fwd / Rev / Ping / Rnd |
| 4 | **Ch−** — decrement MIDI out channel |
| 5 | **Ch+** — increment MIDI out channel |

## Hardware buttons

- **+ / −** — transpose ±1 octave (clamped ±48 semitones)
- **← / →** — step page (for 24- and 32-step patterns)
- **X** (Delete) — CLEAR; gated, requires **Shift+X**
- **Undo** — revert last NEW / MUTATE / CLEAR
- **Play** — transport (passthrough to Move firmware)

## LED colors

- **Steps** — white = note, red = accent, blue = slide, off = rest. Cursor blinks yellow.
- **Banks** — purple = current, teal = filled, off = empty. Yellow flash = bank queued for next-bar recall. With Shift held, the whole row pulses red/pink (save targets).
- **Action row** — teal NEW, indigo MUT, orange DIR.
- **Pages** — green = current page, white = available.
- **Track buttons** — bright teal = active 3PO, bright orange = active 303; dark grey = inactive; off = no 303 reachable.
- **Knob rings** — lit for the encoders that do something on the page you are on (knobs 1-4 white, 5-8 amber), brightness following the value; dark means turning it does nothing.

## Sync

Tempo follows Move's project BPM automatically. TB-3PO runs free (not gated by Move's transport) — use Move's Play button to start/stop.

## Suspend / exit

- **Back** — closes an open option list (or the list raised by turning an enum) first; with nothing open, hides TB-3PO while both slots keep sequencing in the background.
- **Shift+Back** — full exit (release notes, unload).
- **Shift+Vol+Back** — also suspends.
- **Shift+Vol+Jog Click** — also full exit.
- Re-open from Tools menu → resumes with patterns + position intact.

## License

GPL-3.0 — inherited from the Phazerville Hemisphere Suite upstream (`TB_3PO.h`). Schwung itself is MIT; this module is a separate repository and keeps its own license.

## Credits

- Algorithm: djphazer and Hemisphere Suite contributors — [O_C-Phazerville](https://github.com/djphazer/O_C-Phazerville).
- Port: Charles Vestal.
