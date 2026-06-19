// The analytic colormaps moved to @schema/colormap.ts — the DAG root, so the one polynomial fit
// is reachable by both render (transferFunction.ts bakes the LUT from it) and ui (the colorbar
// gradient paints from it) without a boundary violation. Re-exported here so render-internal
// importers and render/index.ts keep their `./colormap.ts` import site.

export {
  COLORMAP_COEFFS,
  type ColormapName,
  colormapColor,
  type Rgb,
  resolveColormapName,
} from "@schema/colormap.ts";
