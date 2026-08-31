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
import { drawBigLane, drawMiniLane, windowFor } from "./lane.mjs";
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
 *   shiftHeld, diveHint
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

    /* PERFORM's page name names the window: "Steps 1-16", "Steps 17-32". */
    const pageName = page.kind === "perform"
        ? page.name + " " + (view.stepView * 16 + 1) + "-" + (view.stepView * 16 + 16)
        : page.name;
    drawHeader(ctx, view.slotLabel + " - " + (view.bpm | 0), pageName, false);
    drawBankBar(ctx, view.pageIndex, view.ring.length, null);

    if (page.kind === "perform") {
        /* The window the USER chose, because the pads edit what is shown. */
        drawBigLane(fb, ctx, { ...view, stepBase: view.stepView * 16 },
                    { x: 0, y: 12, w: 128, h: 22 });
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
 * footer is seven pixels otherwise spent on hints that stop being read.
 *
 * KNOB PAGES ONLY, deliberately. Pads and Keys are pages you READ rather than
 * play, and their footers carry the one thing those pages cannot say any other
 * way -- "TAP: REST>NOTE>ACC>SLIDE" is not derivable from a picture of the pad
 * grid, and it has nowhere else to go, the map filling the body. Trading that
 * for an ambient lane on a page nobody performs from is the wrong way round.
 */
function drawFooterLane(fb, ctx, view) {
    /*
     * A DIVABLE CELL IS ANNOUNCED IN THE FOOTER, and it costs the lane.
     *
     * Nothing on the cell says a click will open it -- corner brackets and the
     * chevron box mark other things, and 953 of the fleet's 967 divable cells
     * wear no mark at all -- so the footer is where the promise has to live,
     * and it is `CLK OPEN`, the same pair the shared grid's held-knob branch
     * puts there. Two pairs need the width the mini lane is using, and the lane
     * is ambient: it is worth reading when your hands are off the knobs, which
     * is precisely when this hint is absent. So they take turns rather than
     * fighting over 82 pixels, and the swap only happens while a divable knob
     * is actually held.
     */
    if (view.diveHint) {
        drawFooter(ctx, [["JOG", "PAGE"], ["CLK", "OPEN"]]);
        return;
    }
    drawFooter(ctx, [["JOG", "PAGE"]]);
    ctx.fillRect(46, 56, 82, 8, 0);
    /* The window the MUSIC is in, because nothing here is editable and there
     * is no room to say which window you are looking at. */
    drawMiniLane(fb, ctx, { ...view, stepBase: windowFor(view.position) },
                 { x: 48, y: FOOTER_BAND.y, w: 80, h: FOOTER_BAND.h });
}
