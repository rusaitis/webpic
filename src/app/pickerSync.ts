import type { MarkerConfig, RenderWorkerRequest } from "@render";
import type { Rgba01, Theme } from "@schema/theme.ts";
import type { SimulationStore } from "@store";
import { resolveOverlayColors } from "./sceneSync.ts";

// Bridges the store's point-picker state to the render worker (app-only: it imports both @store and
// @render, which the DAG forbids either of them from doing). Mirrors sceneSync: the build config
// (theme colors + guide plane) is low-frequency and rides setMarker on the showPicker toggle; the live
// position + hover/active state ride the cheap setPickerPoint. Gated on `workerReady` with a flushAll
// catch-up replayed on the worker `ready` (setDataset + the initial picker state run before `ready`).

// Disjoint from app/main.ts (1-8, 10), layerSync (9), and sceneSync (10) so worker error echoes
// attribute correctly.
const MARKER_REQUEST_ID = 11;
const PICKER_POINT_REQUEST_ID = 12;

// Default accent when the theme omits one — a warm amber that reads on the dark default background.
const FALLBACK_ACCENT: Rgba01 = [1, 0.78, 0.25, 1];
// The drop-line + crosshair reuse the grid color, nudged more opaque for legibility (magviz's boost).
const GUIDE_MIN_OPACITY = 0.55;

/** Resolve the marker's build config from a theme — accent core + grid-derived guide color. Pure. */
export function buildMarkerConfig(theme?: Theme): MarkerConfig {
  const grid = resolveOverlayColors(theme).grid;
  return {
    coreColor: theme?.colors.accent ?? FALLBACK_ACCENT,
    guideColor: [grid[0], grid[1], grid[2], Math.max(grid[3], GUIDE_MIN_OPACITY)],
    // The guide plane matches the grid overlay's held plane (sceneSync.buildOverlayPayload: "center").
    planePosition: "center",
  };
}

export interface PickerSyncOptions {
  readonly store: SimulationStore;
  readonly worker: Pick<Worker, "postMessage">;
  readonly isReady: () => boolean;
  /** Static per session — colors are resolved once at install (no runtime theme swap yet). */
  readonly theme?: Theme;
}

export interface PickerSync {
  /** Post the current marker config + position (catch-up on the worker `ready`, like sceneSync). */
  readonly flushAll: () => void;
  readonly dispose: () => void;
}

export function installPickerSync(opts: PickerSyncOptions): PickerSync {
  const { store, worker, isReady } = opts;
  const config = buildMarkerConfig(opts.theme);

  const postMarker = (): void => {
    if (!isReady()) return;
    worker.postMessage({
      kind: "setMarker",
      requestId: MARKER_REQUEST_ID,
      marker: store.getState().overlay.showPicker ? config : null,
    } satisfies RenderWorkerRequest);
  };

  const postPoint = (): void => {
    if (!isReady()) return;
    const { pickerPoint, pickerHover, pickerActive } = store.getState();
    worker.postMessage({
      kind: "setPickerPoint",
      requestId: PICKER_POINT_REQUEST_ID,
      point: pickerPoint,
      hovered: pickerHover,
      active: pickerActive,
    } satisfies RenderWorkerRequest);
  };

  // showPicker toggle builds/tears down; position + hover + active move/animate the live marker.
  const unsubShow = store.subscribe((s) => s.overlay.showPicker, postMarker);
  const unsubPoint = store.subscribe((s) => s.pickerPoint, postPoint);
  const unsubHover = store.subscribe((s) => s.pickerHover, postPoint);
  const unsubActive = store.subscribe((s) => s.pickerActive, postPoint);

  return {
    flushAll() {
      postMarker();
      postPoint();
    },
    dispose() {
      unsubShow();
      unsubPoint();
      unsubHover();
      unsubActive();
    },
  };
}
