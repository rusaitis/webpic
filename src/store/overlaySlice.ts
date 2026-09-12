import * as overlayOps from "./overlay.ts";
import { DEFAULT_OVERLAY } from "./overlay.ts";
import { identityUpdater, type OverlaySlice, type SliceContext } from "./state.ts";

// Scene overlay display prefs (axes, grid, gnomon, picker) — every setter runs a pure op and commits
// only a real change.

export function createOverlaySlice(context: SliceContext): OverlaySlice {
  const update = identityUpdater(context, "overlay");
  return {
    overlay: DEFAULT_OVERLAY,
    setOverlayShowGrid(on) {
      update((o) => overlayOps.setOverlayFlag(o, "showGrid", on));
    },
    setOverlayPlane(plane, on) {
      update((o) => overlayOps.setPlane(o, plane, on));
    },
    setOverlayShowAxes(on) {
      update((o) => overlayOps.setOverlayFlag(o, "showAxes", on));
    },
    setOverlayShowLabels(on) {
      update((o) => overlayOps.setOverlayFlag(o, "showLabels", on));
    },
    setOverlayShowGnomon(on) {
      update((o) => overlayOps.setOverlayFlag(o, "showGnomon", on));
    },
    setOverlayShowPicker(on) {
      update((o) => overlayOps.setOverlayFlag(o, "showPicker", on));
    },
    setGridDivisions(n) {
      update((o) => overlayOps.setGridDivisions(o, n));
    },
  };
}
