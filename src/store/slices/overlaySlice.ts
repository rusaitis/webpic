import * as overlayOps from "../intents/overlay.ts";
import { DEFAULT_OVERLAY } from "../intents/overlay.ts";
import { identityUpdater, type OverlaySlice, type SliceContext } from "../state.ts";

// Scene overlay display prefs (axes, grid, gnomon, picker) — every setter runs a pure op and commits
// only a real change.

export function createOverlaySlice(context: SliceContext): OverlaySlice {
  const update = identityUpdater(context, "overlay");
  return {
    overlay: DEFAULT_OVERLAY,
    setOverlayFlag(flag, on) {
      update((o) => overlayOps.setOverlayFlag(o, flag, on));
    },
    setOverlayPlane(plane, on) {
      update((o) => overlayOps.setPlane(o, plane, on));
    },
    setGridDivisions(n) {
      update((o) => overlayOps.setGridDivisions(o, n));
    },
  };
}
