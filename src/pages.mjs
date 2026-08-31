/*
 * Page composition: header, bank bar, body, footer.
 *
 * Bodies come from the SHARED library rather than being reimplemented, which
 * is the whole point of the redesign — every widget, the label abbreviations,
 * the touch strip and the enum square arrive with it, and later work on them
 * lands here for free.
 */
import { renderPageMovy, drawKnobRow, drawHeader, drawBankBar, drawFooter }
    from "/data/UserData/schwung/shared/param_pages/render_page_movy.mjs";
import { buildMetaIndex }
    from "/data/UserData/schwung/shared/param_pages/param_meta.mjs";
import { createAnimState }
    from "/data/UserData/schwung/shared/param_pages/anim_state.mjs";
import { TB3PO_PARAMS, PAGE_PATTERN } from "./params.mjs";
import { drawBigLane, drawMiniLane } from "./lane.mjs";
import { drawPadsPage, drawKeysPage } from "./pad_map.mjs";

export const META = buildMetaIndex({ chainParams: TB3PO_PARAMS });
const ANIM = createAnimState();

const FOOTER_BAND = { y: 57, h: 7 };

function common(view) {
    return {
        metaIndex: META, values: view.values, anim: ANIM, nowMs: Date.now(),
        touched: view.touched, touchedSlots: view.touched >= 0 ? [view.touched] : [],
        modulated: () => false,
    };
}

/**
 * @param {object} view
 *   slotLabel, bpm, ring, pageIndex, steps, position, values, touched,
 *   shiftHeld
 */
export function drawPage(fb, ctx, view) {
    const page = view.ring[view.pageIndex];

    if (page.kind === "knobs") {
        renderPageMovy(ctx, Object.assign(common(view), {
            page, title: view.slotLabel,
            pageIndex: view.pageIndex, pageCount: view.ring.length,
        }));
        drawFooterLane(fb, ctx, view);
        return;
    }

    drawHeader(ctx, view.slotLabel + " - " + (view.bpm | 0), page.name, false);
    drawBankBar(ctx, view.pageIndex, view.ring.length, null);

    if (page.kind === "perform") {
        drawBigLane(fb, ctx, view, { x: 0, y: 12, w: 128, h: 22 });
        /*
         * A GENUINE grid row, from Pattern's own key list: drawKnobRow takes
         * its own rowY/lblY, so this is the same code Pattern runs rather than
         * an imitation of it. Holding a knob therefore gives the same
         * full-width touch strip, because it is the same row.
         *
         * Knobs 5-8 do nothing here, and only one row is drawn — the page
         * shows exactly what its knobs do, which is the defect this redesign
         * exists to remove.
         */
        drawKnobRow(ctx, Object.assign(common(view), {
            page: { name: page.name, keys: PAGE_PATTERN.keys.slice(0, 4) },
        }), 0, 33, 48);
        drawFooter(ctx, [["PAD", "STEP"], ["BACK", "SUSPEND"]]);
        return;
    }

    if (page.kind === "pads") {
        drawPadsPage(fb, ctx, view);
        drawFooter(ctx, view.shiftHeld ? [["SHIFT", "HELD"], ["X", "CLEAR"]]
                                       : [["TAP", "REST>NOTE>ACC>SLIDE"]]);
        return;
    }

    if (page.kind === "keys") {
        drawKeysPage(fb, ctx);
        drawFooter(ctx, [["BACK", "SUSPEND"]]);
        return;
    }

    throw new Error("drawPage: unknown page kind " + page.kind);
}

/**
 * The lane in the footer band.
 *
 * This is the only spare real estate on the screen: the bank bar is 2px at
 * y=7 and the grid rows start at y=9, so there is nothing between them. The
 * footer is seven pixels currently spent on hints that stop being read.
 */
function drawFooterLane(fb, ctx, view) {
    drawFooter(ctx, [["JOG", "PAGE"]]);
    ctx.fillRect(46, 56, 82, 8, 0);
    drawMiniLane(fb, ctx, view, { x: 48, y: FOOTER_BAND.y, w: 80, h: FOOTER_BAND.h });
}
