// Rasterise design/icon.svg to design/icon.png at 1024², the size
// `npm run tauri icon` expects as its source.
//
// Uses resvg (a real SVG renderer, vendored as a dev dependency) rather than
// ImageMagick: without librsvg installed system-wide, ImageMagick silently
// falls back to a built-in renderer that drops <path> strokes entirely, which
// produced an icon showing only the dots.
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = readFileSync(new URL("../design/icon.svg", import.meta.url));
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1024 },
  background: "rgba(0,0,0,0)",
});
const png = resvg.render().asPng();
writeFileSync(new URL("../design/icon.png", import.meta.url), png);
console.log(`rendered design/icon.png (${png.length} bytes)`);
