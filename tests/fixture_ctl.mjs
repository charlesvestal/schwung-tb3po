/*
 * A real page controller over a plain value map, for the render tests.
 *
 * The tests used to hand `drawPage` a `values` object and let it plan nothing:
 * the grid was drawn straight out of the fixture. It is the CONTROLLER that
 * draws a knob page now, so a fixture that omits one does not render a smaller
 * page -- it renders NO page, and every assertion about the body passes on an
 * empty band. That is the failure mode this whole exercise is about, so the
 * fixture builds the real thing: the same `createController`, the same
 * contract TB-3PO publishes to itself, the same planner.
 *
 * The values are WIRE values, which is the one thing a fixture can get wrong
 * without the picture looking wrong. `length` and `channel` are declared
 * `options_as_string`, so their wire value is the OPTION TEXT -- "16 Steps",
 * "Ch 1" -- and a bare "1" here does not fail, it silently falls through to
 * the numeric reading and renders channel TWO. Which is precisely the class of
 * defect those declarations exist to prevent, arriving through the fixture
 * instead of through the code.
 */
import { hierarchyFor, TB3PO_PARAMS } from "../src/params.mjs";

const { createController, LAYOUT_MOVY } =
    await import("/data/UserData/schwung/shared/param_pages/page_controller.mjs");

export const FIXTURE_VALUES = {
    density: "0.72", accent: "0.4", slide: "0.25", gate: "0.55",
    root: "9", scale: "0", length: "16 Steps", octaves: "2",
    "303.cutoff": "96", "303.resonance": "74", "303.decay": "58", "303.env_mod": "88",
    "303.accent": "64", "303.volume": "100", "303.drive": "30", "303.drive_mix": "45",
    channel: "Ch 1", direction: "0", transpose: "0", current_bank: "3",
};

/**
 * @param {object} [o]
 * @param {boolean} [o.has303]  whether the 303 level is in the contract
 * @param {object}  [o.values]  wire values, merged over FIXTURE_VALUES
 * @returns {{ctl: object, writes: Array<[string,string]>}}
 */
export function makeController({ has303 = true, values = {} } = {}) {
    const store = Object.assign({}, FIXTURE_VALUES, values);
    const hierarchy = JSON.stringify(hierarchyFor({ has303 }));
    const chainParams = JSON.stringify(TB3PO_PARAMS);
    const writes = [];
    const bare = (k) => (k.indexOf(":") >= 0 ? k.slice(k.indexOf(":") + 1) : k);
    const ctl = createController({
        getParam: (k) => {
            const key = bare(k);
            if (key === "ui_hierarchy") return hierarchy;
            if (key === "chain_params") return chainParams;
            return key in store ? store[key] : "";
        },
        setParam: (k, v) => { const key = bare(k); store[key] = v; writes.push([key, v]); },
        announce: () => {},
    });
    ctl.setLayout(LAYOUT_MOVY);
    ctl.load({ slot: 0, component: "synth" });
    return { ctl, writes, store };
}
