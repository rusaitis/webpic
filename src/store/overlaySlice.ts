import * as overlayOps from "./overlay.ts";
import { DEFAULT_OVERLAY, type OverlayState } from "./overlay.ts";
import type { OverlaySlice, SliceContext } from "./state.ts";

// Scene overlay display prefs (axes, grid, gnomon, picker) — every setter runs a pure op and commits
// only a real change.

export function createOverlaySlice({ get, set }: SliceContext): OverlaySlice {
  const update = (op: (overlay: OverlayState) => OverlayState): void => {
    const { overlay } = get();
    const next = op(overlay);
    if (next !== overlay) set({ overlay: next });
  };
  return {
    overlay: DEFAULT_OVERLAY,
    setOverlayShowGrid(on) {
      update((o) => overlayOps.setShowGrid(o, on));
    },
    setOverlayPlane(plane, on) {
      update((o) => overlayOps.setPlane(o, plane, on));
    },
    setOverlayShowAxes(on) {
      update((o) => overlayOps.setShowAxes(o, on));
    },
    setOverlayShowLabels(on) {
      update((o) => overlayOps.setShowLabels(o, on));
    },
    setOverlayShowGnomon(on) {
      update((o) => overlayOps.setShowGnomon(o, on));
    },
    setOverlayShowPicker(on) {
      update((o) => overlayOps.setShowPicker(o, on));
    },
    setGridDivisions(n) {
      update((o) => overlayOps.setGridDivisions(o, n));
    },
  };
}
