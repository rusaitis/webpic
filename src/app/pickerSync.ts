import { type MarkerConfig, REQUEST_IDS, type RenderWorkerRequest } from "@render/messages.ts";
import type { Rgba01, Theme } from "@schema/theme.ts";
import type { SimulationStore } from "@store";
import { resolveOverlayColors } from "./sceneSync.ts";
import { createStoreBridge } from "./storeBridge.ts";

// Bridges the store's point-picker state to the render worker (app-only glue: store and render can't
// import each other). Mirrors sceneSync: the build config (theme colors + guide plane) is low-
// frequency and rides setMarker on the showPicker toggle; the live position + hover/active state ride
// the cheap setPickerPoint. Gated on `workerReady` (via the shared store bridge) with a flushAll
// catch-up replayed on the worker `ready` (setDataset + the initial picker state run before `ready`).

// Default accent when the theme omits one — a warm amber that reads on the dark default background.
const FALLBACK_ACCENT: Rgba01 = [1, 0.78, 0.25, 1];
// The drop-line + crosshair reuse the grid color, nudged more opaque for legibility (magviz's boost).
const GUIDE_MIN_OPACITY = 0.55;

/** Resolve the marker's build config from a theme — accent core + grid-derived guide color. Pure. */
function buildMarkerConfig(theme?: Theme): MarkerConfig {
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
  /** The boot theme; a runtime switch rides setTheme (the app theme bridge). */
  readonly theme?: Theme;
}

export interface PickerSync {
  /** Post the current marker config + position (catch-up on the worker `ready`, like sceneSync). */
  readonly flushAll: () => void;
  /** Re-resolve the marker palette from a new theme and rebuild it (the theme switcher). */
  readonly setTheme: (theme: Theme | undefined) => void;
  readonly dispose: () => void;
}

export function installPickerSync(opts: PickerSyncOptions): PickerSync {
  const { store, worker, isReady } = opts;
  let config = buildMarkerConfig(opts.theme);
  const bridge = createStoreBridge(store, isReady);

  // The readiness gate lives in the bridge (subscribeWhenReady); flushAll is only called post-ready.
  const postMarker = (): void => {
    worker.postMessage({
      kind: "setMarker",
      requestId: REQUEST_IDS.marker,
      marker: store.getState().overlay.showPicker ? config : null,
    } satisfies RenderWorkerRequest);
  };

  const postPoint = (): void => {
    const { pickerPoint, pickerHover, pickerActive } = store.getState();
    worker.postMessage({
      kind: "setPickerPoint",
      requestId: REQUEST_IDS.pickerPoint,
      point: pickerPoint,
      hovered: pickerHover,
      active: pickerActive,
    } satisfies RenderWorkerRequest);
  };

  // showPicker toggle builds/tears down; position + hover + active move/animate the live marker.
  bridge.subscribeWhenReady((s) => s.overlay.showPicker, postMarker);
  bridge.subscribeWhenReady((s) => s.pickerPoint, postPoint);
  bridge.subscribeWhenReady((s) => s.pickerHover, postPoint);
  bridge.subscribeWhenReady((s) => s.pickerActive, postPoint);

  return {
    flushAll() {
      postMarker();
      postPoint();
    },
    setTheme(theme) {
      config = buildMarkerConfig(theme);
      if (isReady()) postMarker();
    },
    dispose: () => bridge.dispose(),
  };
}
