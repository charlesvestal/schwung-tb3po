/*
 * TB-3PO's modules import the shared library by its DEVICE path. On a Mac
 * those paths do not exist, so this hook rewrites them onto the sibling
 * schwung checkout. Keeping the device path in the source is deliberate: the
 * shipped file must be byte-identical to the tested one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEVICE = "/data/UserData/schwung/";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHWUNG_SRC = path.resolve(HERE, "../../schwung/src");

if (!fs.existsSync(SCHWUNG_SRC)) {
    throw new Error(
        "tests need the sibling schwung checkout at " + SCHWUNG_SRC +
        " — clone charlesvestal/schwung next to this repo");
}

export function resolve(specifier, context, next) {
    if (specifier.startsWith(DEVICE)) {
        const rel = specifier.slice(DEVICE.length);
        return { url: pathToFileURL(path.join(SCHWUNG_SRC, rel)).href, shortCircuit: true };
    }
    return next(specifier, context);
}
