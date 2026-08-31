/*
 * Page composition: header, bank bar, body, footer.
 *
 * THE CONTROLLER DRAWS THE BODY OF A KNOB PAGE. TB-3PO DRAWS EVERYTHING ELSE.
 *
 * This file used to plan, dispatch and draw the grid itself — a hand-rolled
 * page set, a knob->key table, its own touch tracking, its own readout guard
 * and its own dive picker, all sitting on top of `renderPageMovy`. That was a
 * second implementation of `page_controller.mjs`, which is the thing this
 * exercise exists to remove. schwung-movy-embed made and undid exactly the
 * same mistake (`src/renderer/schwung-page.ts`) and its finding was that the
 * pieces you re-derive are never the ones you meant to: it lost every page
 * kind that was not a knob page, this lost the widget animation store, the
 * write and announce throttles, the staggered read cursor and the graphics.
 *
 * So the controller now owns the three knob pages — planning, dispatch, knob
 * feel, values, widgets and graphics — and is asked for the BODY ALONE.
 * TB-3PO supplies its own header and bank bar (which count SIX pages, not the
 * controller's three) and its own footer, exactly as movy does.
 */
import { drawKnobRow, drawHeader, drawBankBar, drawFooter, movyHeaderFor }
    from "/data/UserData/schwung/shared/param_pages/render_page_movy.mjs";
import { buildMetaIndex, isDivable }
    from "/data/UserData/schwung/shared/param_pages/param_meta.mjs";
import { createAnimState }
    from "/data/UserData/schwung/shared/param_pages/anim_state.mjs";
import { TB3PO_PARAMS } from "./params.mjs";
import { drawBigLane, drawMiniLane, windowFor } from "./lane.mjs";
import { drawPadsPage, drawKeysPage } from "./pad_map.mjs";

/*
 * A fallback meta index, for PERFORM's row before the controller has planned.
 * The controller builds its own from the same TB3PO_PARAMS, so the two cannot
 * disagree about a declaration; this one exists so a frame drawn during the
 * first load is not a frame with no metadata.
 */
export const META = buildMetaIndex({ chainParams: TB3PO_PARAMS });
const ANIM = createAnimState();

const FOOTER_BAND = { y: 57, h: 7 };

/*
 * WHERE THE CONTROLLER MAY DRAW, AND WHAT IT MAY DRAW THERE.
 *
 * All three chrome bands are off: TB-3PO's header carries the slot and the
 * held-knob readout, its bank bar counts the SIX outer pages (the controller's
 * own would count three and disagree), and its footer carries the lane.
 *
 * `y: 8` is not a typo and is not ROW0_Y. With every band stood down the
 * layout CLOSES UP — that is the whole reason it is a layout function — so the
 * first knob row lands at `rect.y + BAND_H.gutter0`, one pixel below the rect
 * top. Passing 9 puts the rows at [[10,25],[34,49]], one pixel below where the
 * device has always drawn them; backing off by that gutter reproduces
 * [[9,24],[33,48]] exactly. tests/pages.mjs asserts the numbers, not the
 * reasoning.
 */
export const BANDS = Object.freeze({ header: false, bank: false, footer: false });
export const BODY = Object.freeze({ x: 0, y: 8, w: 128, h: 49 });

/* PERFORM's live knobs: Pattern's row 0, the same four in the same positions. */
export const PERFORM_KNOBS = 4;

/**
 * The page the CONTROLLER is on, as PERFORM wants to see it: row 0 only.
 *
 * Not a copy of Pattern's key list — it is Pattern's key list, sliced off the
 * page the controller has planned. A knob that means Octaves on one page and
 * Gate on another is the defect this redesign exists to remove, and the only
 * way to be sure is for both pages to read the same array.
 */
function performPage(ctl) {
    const p = ctl && ctl.page;
    if (!p || !Array.isArray(p.keys)) return { name: "Steps", keys: [] };
    return { name: "Steps", keys: p.keys.slice(0, PERFORM_KNOBS) };
}

/**
 * @param {object} view
 *   slotLabel, bpm, pages, pageIndex, steps, position, stepView, shiftHeld,
 *   touched, ctl
 */
export function drawPage(fb, ctx, view) {
    const page = view.pages[view.pageIndex];
    const ctl = view.ctl;

    /*
     * THE HELD KNOB'S READOUT IS LOST BY CONSTRUCTION, and this is where it
     * comes back.
     *
     * `bands.header: false` means the controller never draws the strip that
     * turns into "<full param name>  <value>" while a knob is under a hand —
     * so without this TB-3PO's header would go on saying "Pattern" through the
     * whole gesture, which is a regression against what the device draws
     * today. `movyHeaderFor` is the exported pure form of that rule, so the
     * two headers cannot describe the same state differently.
     *
     * `pageLabel` is TB-3PO'S OWN page name. The planner calls the root grid
     * page "Main" whatever the level declares; TB-3PO's set says "Pattern",
     * and TB-3PO's set is the sole authority for anything user-visible. Passed
     * here rather than corrected afterwards, so the controller's name has no
     * path to the screen at all.
     */
    const gridPage = page.kind === "perform" ? performPage(ctl)
                   : page.kind === "knobs" ? ((ctl && ctl.page) || null)
                   /* Pads and Keys have no cells, so nothing can be held on
                    * them and the readout branch must not be reachable. */
                   : null;
    /* PERFORM's page name names the window: "Steps 1-16", "Steps 17-32". */
    const pageName = page.kind === "perform"
        ? page.name + " " + (view.stepView * 16 + 1) + "-" + (view.stepView * 16 + 16)
        : page.name;
    /* The BPM rides on the pages with room for it. A knob page's header is
     * eight characters of slot name against a page name and, when a knob is
     * held, the param's full name and value -- there is nowhere to put it. */
    const title = page.kind === "knobs" ? view.slotLabel
                                        : view.slotLabel + " - " + (view.bpm | 0);
    const header = movyHeaderFor({
        page: gridPage,
        metaIndex: (ctl && ctl.metaIndex) || META,
        values: (ctl && ctl.state.values) || {},
        touched: view.touched,
        title: title,
        pageLabel: pageName,
    });
    drawHeader(ctx, header.left, header.right, header.inverted);
    /* SIX segments, from the OUTER index. The controller's own bar would count
     * three, which is why `bands.bank` is false — with both drawing, the two
     * would sit in the same band saying different things. */
    drawBankBar(ctx, view.pageIndex, view.pages.length, null);

    if (page.kind === "knobs") {
        /* The body, and only the body. Every widget, label abbreviation, enum
         * square, animation and graphic arrives with it. */
        if (ctl) ctl.render(ctx, { title: view.slotLabel, rect: BODY, bands: BANDS });
        drawFooterLane(fb, ctx, view, gridPage);
        return;
    }

    if (page.kind === "perform") {
        /* The window the USER chose, because the pads edit what is shown. */
        drawBigLane(fb, ctx, { ...view, stepBase: view.stepView * 16 },
                    { x: 0, y: 12, w: 128, h: 22 });
        /*
         * A GENUINE grid row, from the controller's own Pattern page. Not a
         * second render path: `drawKnobRow` is the same call `renderPageMovy`
         * makes for row 0, fed from the same metadata and the same values, so
         * holding a knob here gives the same full-width touch strip because it
         * is the same row.
         *
         * The controller cannot draw this itself: its body is all-or-nothing
         * (movyBandLayout stands the whole body down rather than dropping one
         * row), and PERFORM has room for one.
         */
        drawKnobRow(ctx, {
            page: gridPage,
            metaIndex: (ctl && ctl.metaIndex) || META,
            values: (ctl && ctl.state.values) || {},
            anim: ANIM, nowMs: Date.now(),
            touched: view.touched,
            touchedSlots: view.touched >= 0 ? [view.touched] : [],
            modulated: () => false,
        }, 0, 33, 48);
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
function drawFooterLane(fb, ctx, view, gridPage) {
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
     *
     * DERIVED here from the CONTROLLER'S page, not handed in. The keys, the
     * metadata and the held slot all come from the one object that dispatches
     * the click, so the footer cannot promise a door the click will not open.
     */
    const meta = (view.ctl && view.ctl.metaIndex) || META;
    const heldKey = (view.touched >= 0 && gridPage && gridPage.keys)
        ? gridPage.keys[view.touched] : null;
    if (heldKey && isDivable(meta.getOrGuess(heldKey))) {
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
