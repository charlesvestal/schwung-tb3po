# TB-3PO — Generative Acid Bassline Sequencer for Schwung

A JS-only module for [Schwung](https://github.com/charlesvestal/schwung) that ports the [Phazerville Hemisphere Suite](https://github.com/djphazer/O_C-Phazerville) `TB_3PO` applet to Move hardware. Generates 303-style patterns with density / accent / slide probabilities, scale-locked notes, pattern banks, mutate, and multiple playback directions.

Pair it in a shadow slot with a resonant monosynth (hush1, Bristol, OB-Xd, Raffo Moog) to get the acid sound — TB-3PO emits MIDI only; the squelch comes from your synth.

## Install

From the Schwung Module Store, or manually:

```bash
git clone https://github.com/charlesvestal/schwung-tb3po
cd schwung-tb3po
./scripts/build.sh && ./scripts/install.sh
```

## Usage

1. Open **Tools** (Shift+Vol+Step13) → pick **TB-3PO**.
2. Set the MIDI channel (param) and load a synth in a shadow slot with matching `receive_channel`.
3. **Back** → suspend (module keeps sequencing while you play Move).
4. **Shift+Back** → full exit.
5. Re-open from Tools menu → resumes where you left off.

## Requirements

- Schwung **v0.9.8 or later** — requires the `suspend_keeps_js` capability.

## License

GPL-3.0 — inherited from the Phazerville Hemisphere Suite upstream (`TB_3PO.h`). Schwung itself is MIT; this module is a separate repository and keeps its own license.

## Credits

- Algorithm: djphazer and Hemisphere Suite contributors — [O_C-Phazerville](https://github.com/djphazer/O_C-Phazerville).
- Port: Charles Vestal.
