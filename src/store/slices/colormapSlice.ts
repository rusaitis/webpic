import * as colormapOps from "../colormap.ts";
import { type ColormapSlice, identityUpdater, type SliceContext } from "../state.ts";

// The ColormapBinding registry — every setter runs a pure op and commits only a real change.

export function createColormapSlice(context: SliceContext): ColormapSlice {
  const update = identityUpdater(context, "colormapBindings");
  return {
    colormapBindings: {},
    setBindingColormap(id, colormap) {
      update((b) => colormapOps.setBindingColormap(b, id, colormap));
    },
    setBindingWindow(id, center, width) {
      update((b) => colormapOps.setBindingWindow(b, id, center, width));
    },
    setBindingScale(id, scale) {
      update((b) => colormapOps.setBindingScale(b, id, scale));
    },
  };
}
