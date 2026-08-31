/*
 * The step lane, at two densities.
 *
 * PERFORM gets the big one; every other page gets the compressed one in the
 * footer band. They are deliberately the same drawing rather than two
 * designs — same information, two zoom levels — so a mark must not change
 * MEANING between them, only size.
 */

export const REST = 0, NOTE = 1, ACCENT = 2, SLIDE = 3;

/*
 * Both lanes draw a 16-step WINDOW, because a pattern is 8, 16, 24 or 32 steps
 * and the screen is 128px wide.
 *
 * The two lanes pick their window differently, and the asymmetry is the point:
 *
 *   The BIG lane is something you EDIT. The pads write into the window on
 *   screen, so it must be the window the user chose with the < > buttons --
 *   auto-scrolling it would move the target out from under their hands.
 *
 *   The MINI lane is something you WATCH. It is ambient, has no interaction,
 *   and no room to say which window it is showing, so it always follows the
 *   playhead.
 *
 * An earlier draft of this file hard-coded steps 0..15 in both, which silently
 * dropped the back half of every 24- and 32-step pattern and lost the playhead
 * entirely once it passed step 15 -- while the Keys page still advertised
 * "< >  STEP PG".
 */
export function windowFor(position) { return Math.floor((position | 0) / 16) * 16; }

/* A slide is a note that ties into the next step, so it stands as tall as a
 * plain note. */
function isRest(s) { return s === REST; }
function isAccent(s) { return s === ACCENT; }

/**
 * The top row of one step's bar. A rest has only its floor pixel, so that row
 * is its "top" for tie purposes.
 */
function miniTop(y, h, s) {
    if (isRest(s)) return y + h - 1;
    return y + h - (isAccent(s) ? h : Math.max(2, h - 3));
}

/**
 * The 16-step lane compressed into a footer band.
 *
 * @param {object} state { steps: number[], position: number, heightOf?: fn }
 * @param {object} rect  { x, y, w, h }
 */
export function drawMiniLane(fb, ctx, state, rect) {
    const { x, y, w, h } = rect;
    const base = state.stepBase | 0;
    /* `?? REST` rather than a bare index: a window running past the end of a
     * short pattern must read as empty, and an undefined entry falls through
     * both isRest and isAccent into the note branch, i.e. it would draw as a
     * lit bar. */
    const at = (i) => state.steps[base + i] ?? REST;
    const cw = w / 16;
    /* `heightOf` lets a test pin a slide's height without inventing a fifth
     * step state; in production a slide is always note-height. */
    const heightState = (i) =>
        state.heightOf ? state.heightOf(i) : (at(i) === SLIDE ? NOTE : at(i));

    for (let i = 0; i < 16; i++) {
        const cx = Math.round(x + i * cw), nx = Math.round(x + (i + 1) * cw);
        const bw = Math.max(1, nx - cx - 1);
        const s = at(i);

        if (base + i === state.position) {
            /* Full height, because the playhead is the one mark that has to
             * survive the compression whatever the step under it is. */
            ctx.fillRect(cx, y, bw, h, 1);
        } else if (isRest(s)) {
            ctx.fillRect(cx, y + h - 1, bw, 1, 1);
        } else {
            const top = miniTop(y, h, heightState(i));
            ctx.fillRect(cx, top, bw, y + h - top, 1);
        }

        if (s === SLIDE && i < 15) {
            /*
             * One pixel in the 1px gap the bars leave, TWO ROWS BELOW the
             * heads. At the head the pair reads as an arch, which at this size
             * is a smudge across three columns; dropped, it makes an H, and an
             * H is a shape the eye finds without looking for it.
             *
             * Measured from the DEEPER of the two heads: the crossbar has to
             * sit where both uprights exist, or an accent tied to a plain note
             * leaves the pixel floating above the second bar.
             */
            const deeper = Math.max(miniTop(y, h, heightState(i)),
                                    miniTop(y, h, heightState(i + 1)));
            ctx.fillRect(nx - 1, Math.min(deeper + 2, y + h - 1), 1, 1, 1);
        }
    }
}

/**
 * The full-size lane. Baseline across the rect, 8px per step.
 *
 * @param {object} rect { x, y, w, h } — h must be at least 19.
 */
export function drawBigLane(fb, ctx, state, rect) {
    const stepBase = state.stepBase | 0;
    const at = (i) => state.steps[stepBase + i] ?? REST;
    const base = rect.y + rect.h - 6;
    ctx.fillRect(rect.x, base, rect.w, 1, 1);

    for (let i = 0; i < 16; i++) {
        const x = rect.x + i * 8, s = at(i);
        if (isRest(s)) continue;
        const bh = isAccent(s) ? 13 : 8;
        ctx.fillRect(x + 2, base - bh, 5, bh, 1);
        /* The same tie, at the size where it can be a full bridge rather than
         * a single pixel. */
        if (s === SLIDE && i < 15) ctx.fillRect(x + 2, base - bh, 7, 1, 1);
    }
    for (let i = 0; i <= 16; i += 4) {
        ctx.fillRect(Math.min(rect.x + i * 8, rect.x + rect.w - 1), base + 1, 1, 3, 1);
    }
    /* Only when the playhead is inside the window being shown. */
    const pcol = (state.position | 0) - stepBase;
    if (pcol >= 0 && pcol < 16) ctx.fillRect(rect.x + pcol * 8 + 1, base + 2, 7, 2, 1);
}
