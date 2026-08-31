/*
 * The Pads and Keys pages.
 *
 * The pad map is a picture of the surface at its own proportions — four rows
 * of eight, drawn where the hands are — replacing a text HELP page that
 * clipped 21px off the right edge and repeated help.json.
 */
import { fontPrint4x5, fontWidth4x5 }
    from "/data/UserData/schwung/shared/param_pages/font4x5.mjs";

export const MAP_TOP = 13;
export const CELL_W = 16;
/*
 * The action row is TALLER than the three band rows. A band row needs one
 * clear row around a single label; the action row needs its labels clear of
 * the cell frames too. At a uniform 10px the frames ran into the tops of the
 * glyphs.
 */
export const BAND_H = 9;
export const ACT_H = 13;
const ACT_Y = MAP_TOP + 3 * BAND_H;

/*
 * Pad 1 is GEN, not NEW.
 *
 * A cell is 16px and its divider owns one column, so a label has 14. "NEW"
 * measures 15; "GEN" measures 14. Nearly every three-letter word in this face
 * lands on 14 or 15, so this is the constraint rather than a preference —
 * tests/pad_map.mjs measures every one of these.
 */
export const ACTION_LABELS = ["GEN", "MUT", "DIR", "CH-", "CH+", "", "", ""];

const caps = (s) => String(s).toUpperCase();

function bandY(row) { return MAP_TOP + row * BAND_H; }

/** One row-wide label, knocked out of the grid it sits on. */
function band(ctx, row, text, inverted) {
    const y = bandY(row);
    const t = caps(text), tw = fontWidth4x5(t);
    const tx = Math.floor((128 - tw) / 2), ty = y + 2;
    if (inverted) ctx.fillRect(0, y + 1, 128, BAND_H - 2, 1);
    /* Without the knockout the cell dividers run straight through the glyphs. */
    ctx.fillRect(tx - 3, ty - 1, tw + 6, 7, inverted ? 1 : 0);
    fontPrint4x5(ctx, tx, ty, t, inverted ? 0 : 1);
}

/** One action pad's label, centred on the interior its divider leaves. */
function actionCell(ctx, col, text) {
    if (!text) return;
    const t = caps(text), tw = fontWidth4x5(t);
    /*
     * Centred on the 15px INTERIOR, not the 16px cell, and FLOORED from the
     * interior's left edge — the divider is the separator between two
     * adjacent labels, and two 14px labels with no rule between them read as
     * one word because the gap between letters is already 1px.
     */
    fontPrint4x5(ctx, col * CELL_W + 1 + Math.floor((CELL_W - 1 - tw) / 2), ACT_Y + 4, t, 1);
}

function grid(ctx) {
    for (let r = 0; r < 3; r++) {
        const y = bandY(r);
        ctx.fillRect(0, y, 128, 1, 1);
        for (let c = 0; c <= 8; c++) ctx.fillRect(Math.min(c * CELL_W, 127), y, 1, BAND_H, 1);
    }
    ctx.fillRect(0, ACT_Y, 128, 1, 1);
    ctx.fillRect(0, ACT_Y + ACT_H, 128, 1, 1);
    for (let c = 0; c <= 8; c++) ctx.fillRect(Math.min(c * CELL_W, 127), ACT_Y, 1, ACT_H + 1, 1);
}

/**
 * @param {object} o { shiftHeld: boolean }
 *
 * The map REDRAWS while Shift is held rather than being drawn once with the
 * Shift meanings printed somewhere: live state cannot drift from what the
 * pads actually do.
 */
export function drawPadsPage(fb, ctx, o) {
    grid(ctx);
    band(ctx, 0, "steps 1-8", false);
    band(ctx, 1, "steps 9-16", false);
    band(ctx, 2, o.shiftHeld ? "save to bank 1-8" : "banks 1-8", !!o.shiftHeld);
    ACTION_LABELS.forEach((t, i) => actionCell(ctx, i, t));
}

export const COL_X = [2, 66];
export const KEY_W = 26;
export const KEY_ROWS = [
    [["+ -", "octave"],   ["< >", "step pg"]],
    [["shf+x", "clear"],  ["undo", "last op"]],
    [["t1 t2", "slot a - steps / 303"]],
    [["t3 t4", "slot b - steps / 303"]],
    [["step", "pages"],   ["play", "start"]],
];

export function drawKeysPage(fb, ctx) {
    KEY_ROWS.forEach((row, i) => {
        const y = 15 + i * 9;
        row.forEach((pair, c) => {
            fontPrint4x5(ctx, COL_X[c], y, caps(pair[0]), 1);
            fontPrint4x5(ctx, COL_X[c] + KEY_W, y, caps(pair[1]), 1);
        });
    });
}
