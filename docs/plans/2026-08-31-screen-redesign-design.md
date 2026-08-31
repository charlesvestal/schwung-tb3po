# TB-3PO screen redesign — design

2026-08-31. Supersedes the display half of `2026-04-22-dual-slot-design.md`;
the two-slot model and the DSP param namespacing are unchanged.

Every layout here was rendered at 128×64 through the device font atlas with
`tools/param-pages/harness.mjs` before it was written down. Pixel counts in
this document are measured, not estimated.

## Why

Three findings, in the order they are hard to argue with.

1. **The eight knobs are invisible.** In 3PO mode the knobs already drive
   Density, Accent, Slide, Octaves, Root, Scale, Length and Gate directly. The
   screen never draws them — it splits them across two jog-edited text lists
   whose rows are labelled `K1:` and `K5:` so the user can work out which knob
   is which. This is exactly what the knob grid replaced everywhere else in
   Schwung.
2. **None of the chrome is shared.** Hand-rolled header, list and footer; no
   bank bar, so nothing on screen says which of five pages you are on or that
   there are five. The status line is a compressed run — `AMin 124 EXT Ch1 B1
   F` — that has to be decoded rather than read.
3. **Two of the five pages overflow the display.** SCALE draws 18 px past the
   right edge and HELP draws 21. The device discards them silently, so those
   footers have been truncated on hardware since they shipped.

## Direction

Adopt the shipping page chrome: `renderPageMovy` and its header, bank bar,
knob grid and footer, from
`/data/UserData/schwung/shared/param_pages/render_page_movy.mjs`.

TB-3PO is a tool, not a chain component, so nothing hands it a contract. It
declares its own `chain_params`-shaped array locally and builds a meta index
from it:

```js
const META = buildMetaIndex({ chainParams: TB3PO_PARAMS });
```

That is the whole adaptation. `renderPageMovy` takes a plain ctx
(`{ fillRect, print, textWidth }`), so the device globals wire straight in.
Every widget, the label-abbreviation rules, the touch strip, the enum square
and the bank bar come from the library, and later work on them lands in
TB-3PO for free.

## Page ring

**Two rings of six, one per slot.** The track buttons switch rings; jog never
crosses the A/B boundary, which is what keeps a six-segment bank bar readable
as a map rather than as a scrollbar. The header always names the slot the ring
belongs to.

| # | Page | Body |
|---|------|------|
| 1 | PERFORM | Step lane + knob row 0 |
| 2 | Pattern | 8 knobs |
| 3 | 303 | 8 live CC knobs |
| 4 | Setup | Chan, Dir, Transpose, Bank |
| 5 | Pads | Map of the 4×8 grid |
| 6 | Keys | The controls that are not pads |

**The 303 page is absent from the ring when no 303 plugin is reachable** —
five segments, not six. `selectSlotMode` currently refuses that case and
spends an overlay explaining the refusal; under a ring there is nothing to
refuse, and T2/T4 land on Pattern.

**Setup's second row stays empty.** Four knobs on that page do nothing, and
that is accepted: the alternative is moving a param off Pattern purely to fill
space. `renderPageMovy` draws nothing for an empty slot.

## Knobs

| Page | Row 0 (knobs 1–4) | Row 1 (knobs 5–8) |
|------|-------------------|-------------------|
| Pattern | Density, Accent, Slide, **Gate** | Root, Scale, Length, **Octaves** |
| 303 | Cutoff, Reson, Decay, Env Mod | Accent, Volume, Drive, Drive Mix |
| Setup | Chan, Dir, Transpose, Bank | — |
| PERFORM | *Pattern's row 0* | inert |

**PERFORM draws a genuine grid row**, not an imitation: `drawKnobRow` is
exported and takes its own `rowY` / `lblY`, so the same code that draws
Pattern's top row draws it under the lane. Holding a knob gives the same
full-width touch strip, because it is the same row.

That forces the one change in the table above. If PERFORM shows Pattern's top
row it must be **the same four in the same positions**, or knob 4 means
Octaves on one page and Gate on the other — the defect this whole pass exists
to remove. So Pattern regroups: **row 0 is feel**, **row 1 is notes**. It
reads better as a grid too: four dials over four discrete widgets, rather than
the two kinds interleaved.

Knobs 5–8 do nothing on PERFORM, and that is visible rather than hidden —
only one row is drawn.

### Knobs 1–4 do NOT edit key, BPM, bank and direction on PERFORM

1. **BPM is not ours to set.** The DSP reads `host_bpm`; tempo follows Move's
   project tempo. A knob on it would be a knob that does nothing.
2. **The other three already have homes.** Root is knob 5 on Pattern;
   Direction and Bank are knobs 2 and 4 on Setup. One param on two pages under
   different knob numbers is what the grid exists to prevent.
3. It would make PERFORM the page whose knobs do something it does not show.

## Navigation

- **Jog turns pages.** Jog-to-edit-a-list is retired entirely; every value is
  edited by the knob above it.
- **Step buttons 1–6** jump directly to a page in the current ring.
- **T1–T4** switch ring *and* jump: T1 slot A Pattern, T2 slot A 303, T3 slot
  B Pattern, T4 slot B 303. The same fingers as today, with no hidden mode —
  3PO vs 303 was a *knob* mode because there was nowhere to show it, and it is
  now two pages the header names.
- Pads, Shift combos, Back/Shift+Back and the hardware buttons are unchanged.

## The step lane

Two densities of one drawing, not two designs.

**Big lane (PERFORM).** Baseline across 128 px, one 8 px column per step.
Bar height codes the step: accent 13, note 8, rest empty. A slide bridges its
head into the next bar. Beat ticks every 4 steps below the baseline; the
playhead is a 7×2 block under the line.

**Mini lane (footer, every other page).** The same 16 steps compressed into
the 7 px footer band.

- accent = full height, note = height − 3, rest = a single floor pixel
- **the playhead is a full-height column**, which is why it survives the
  compression when a glyph would not
- **a tie is one pixel in the 1 px gap between two bars, two rows below the
  heads**

### Ties

A slide is the one state that describes a *relationship* between two steps
rather than a step, so it cannot be another height — a taller bar reads as
another accent.

Two rows below the heads, not level with them: at the head the pair reads as
an arch, which at this size is a smudge spanning three columns. Dropped, the
same pixel makes an **H**, a shape the eye finds without looking for it.
Dropped four it collapses into a U against the floor, which the baseline
already does.

**The drop is measured from the deeper of the two heads, not from the slide's
own.** The crossbar of an H has to sit at a row where both uprights exist —
tie an accent to a plain note and a pixel two below the accent's head floats
above the note entirely, connecting nothing. That case is invisible in a
pattern of even notes.

An earlier version gave ties a reserved row at the top of the band. It worked,
but it cost every bar a pixel of height to say something about two steps in
sixteen, and a mark floating above the lane reads as an annotation rather than
as a connection.

### Why the footer

The screen has exactly one band of spare real estate. The bank bar is 2 px at
`BAR_Y = 7` and the grid rows start at `ROW0_Y = 9`, so there is nothing
between them. The footer is 7 px at `FOOTER_Y = 57`, currently spent on hints
that stop being read.

One hint pill is kept beside the lane. **This needs a two-line change in
`drawFooter`**: it pins a Back hint to the right edge, which is where the lane
wants to sit. Teaching it that a back hint may sit left when something else
owns the right is better than moving Back around per page.

A hold-to-peek overlay (the full lane over the grid) was rendered and is not
in scope: it is a gesture to learn, and it only helps while held.

## Pads page

A picture of the surface at its own proportions — four rows of eight, drawn
where the hands are. It replaces the HELP page, which clips 21 px and repeats
`help.json`. `help.json` is retained for the Tools help viewer.

```
MAP_TOP  13     CELL_W 16
BAND_H    9     rows 3, 2 and 1 (steps 1-8, steps 9-16, banks 1-8)
ACT_H    13     row 0 (the action pads)
```

- Each band row carries one label knocked out of the grid it sits on, or the
  cell dividers run through the glyphs.
- The action row is labelled per pad: `GEN MUT DIR CH- CH+`, three empty.
- **Every row keeps full-height dividers**, the action row included. Two 14 px
  labels in adjacent cells leave 2 px between their glyphs and the gap
  *between letters* is already 1 px, so without the rule `GEN MUT` reads as one
  word. The rule is the separator.
- Labels are centred on the 15 px **interior** the divider leaves, and
  **rounded, not floored** — floor biases every label a pixel left, which on
  cell 0 puts it on screen column 0.
- **The action row is 13 px against the band rows' 9.** A band row needs one
  clear row around a single label; this row needs its labels clear of the cell
  frames as well. At a uniform height the frames ran into the tops of the
  glyphs.
- **Pad 1 is `GEN`, not `NEW`.** A label has 14 px; `NEW` measures 15 and
  `GEN` measures 14. Nearly every three-letter word in this face lands on 14
  or 15, so this is the constraint rather than a preference. A build-time
  warning fires on any label wider than `CELL_W - 2`.
- **The map redraws while Shift is held**: the bank row inverts to `SAVE TO
  BANK 1-8` and the footer switches to `SHIFT HELD · X CLEAR`. It is live
  state, so it cannot drift from what the pads actually do.

The footer carries the one thing geography cannot: `TAP: REST>NOTE>ACC>SLIDE`.

## Keys page

Two key/action columns at `COL_X = [2, 66]`, `KEY_W = 26`, five rows at 8 px.
The T-button rows are full width. **Every x is measured through
`fontWidth4x5` with an overlap assertion at build time** — that guard caught
four real collisions (`SHF+XCLEAR`, `TRANSPORTJOG`) before the render was
looked at.

## Removed

- The HELP page (replaced by Pads + Keys)
- Mode state — `mode` on the slot struct, `MODE_NAMES`, `PAGE_NAMES_303`
- Jog list editing — `drawMenuList`, `menuState`, the page item builders
- The "No 303 loaded" refusal overlay
- `drawBar`, `drawPageFooter`, `drawPerformPage` and the rest of the
  hand-rolled draw layer

## Verification

- Every frame rendered through the harness asserts `clipped() === 0` and an
  empty `missingGlyphs`. The two pages being replaced currently fail this (18
  and 21 px), which is the regression test for finding 3.
- Pad-label and Keys-column width guards fail the build rather than smudging
  the device.
- A snapshot per page, stored as `toBlocks()`, so a layout change shows up as
  a diff rather than as a report from hardware.
- On-device: the touch strip on PERFORM's inherited row, the Shift redraw on
  Pads, and the ring dropping to five pages with no 303 loaded.

## Open

- Screen-reader announcements for the new pages are not specified here.
  `announce_page.mjs` covers the grid; Pads and Keys need their own text.
