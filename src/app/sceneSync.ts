import type { GridInfo } from "@containers/field_dataset.ts";
import { axisPhysicalSpan, hasUsableSpacing, worldHalfExtentForGrid } from "@containers/grid.ts";
import {
  type OverlayAxis,
  REQUEST_IDS,
  type RenderWorkerRequest,
  type SceneOverlayConfig,
} from "@render/messages.ts";
import { UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import { FALLBACK_AXIS, type Rgba01, type Theme } from "@schema/theme.ts";
import type { OverlayState, SimulationStore } from "@store";
import { createStoreBridge, type RenderWorkerLink } from "./storeBridge.ts";

// Bridges the store's scene-overlay flags + the dataset GridInfo + the resolved theme palette to the
// render worker's setSceneOverlay (app-only glue: store and render can't import each other). Low-
// frequency: a toggle, a density change, or a dataset swap re-posts the full config. Gated on
// `workerReady` (via the shared store bridge) with a flushAll catch-up replayed on the worker `ready`
// message, mirroring layerSync — `setDataset` runs before `ready`, so the initial overlay rides the catch-up.

const GRID_MAJOR_OPACITY = 0.4;

const AXIS_NAMES = ["x", "y", "z"] as const;

// Grid/label fall back to the muted foreground when no theme is loaded; the axis triad shares the
// canonical FALLBACK_AXIS (schema/theme) with the HUD gnomon so the in-scene axes always agree.
const FALLBACK_GRID: Rgba01 = [0.784, 0.816, 0.847, 0.16]; // ≈ --webpic-border
const FALLBACK_LABEL: Rgba01 = [0.784, 0.816, 0.847, 1]; // #c8d0d8 foreground

export interface ResolvedOverlayColors {
  readonly grid: Rgba01;
  readonly axes: { readonly x: Rgba01; readonly y: Rgba01; readonly z: Rgba01 };
  readonly label: Rgba01;
}

// Resolve overlay colors from a theme, per-channel, falling back to the gnomon palette.
export function resolveOverlayColors(theme?: Theme): ResolvedOverlayColors {
  return {
    grid: theme?.colors.grid ?? FALLBACK_GRID,
    axes: {
      x: theme?.axes.x ?? FALLBACK_AXIS.x,
      y: theme?.axes.y ?? FALLBACK_AXIS.y,
      z: theme?.axes.z ?? FALLBACK_AXIS.z,
    },
    label: theme?.colors.text ?? FALLBACK_LABEL,
  };
}

// One field axis → its physical extent (code units) or, when the grid lacks usable spacing, voxel
// indices [0, dim]. Lower-rank grids pad to a degenerate unit axis so the 3-tuple is always complete.
function buildAxis(grid: GridInfo | null, index: number): OverlayAxis {
  const label = grid?.axisLabels[index] ?? AXIS_NAMES[index] ?? `axis${index}`;
  if (grid === null) return { bounds: [0, 1], label };
  const span = axisPhysicalSpan(grid, index);
  const origin = grid.origin[index] ?? 0;
  return { bounds: hasUsableSpacing(grid, index) ? [origin, origin + span] : [0, span], label };
}

// Assemble the worker overlay config from the store flags, the dataset grid, and resolved colors.
// Pure — no DOM, no worker — so the bounds math and color resolution are unit-tested directly.
export function buildOverlayPayload(
  overlay: OverlayState,
  grid: GridInfo | null,
  colors: ResolvedOverlayColors,
): SceneOverlayConfig {
  return {
    axes: [buildAxis(grid, 0), buildAxis(grid, 1), buildAxis(grid, 2)],
    planes: { ...overlay.planes },
    planePosition: "center",
    show: { grid: overlay.showGrid, axes: overlay.showAxes, labels: overlay.showLabels },
    grid: { color: colors.grid, majorOpacity: GRID_MAJOR_OPACITY },
    axisColors: colors.axes,
    labelColor: colors.label,
    tick: { targetCount: overlay.gridDivisions },
    // Same box the volume mesh is scaled to — derived from the same grid as the axis bounds, so the
    // grid/axes wrap the scaled volume exactly (cubic → unit cube).
    worldHalfExtent: grid !== null ? worldHalfExtentForGrid(grid) : UNIT_BOX_HALF_EXTENT,
  };
}

export interface SceneSyncOptions extends RenderWorkerLink {
  readonly store: SimulationStore;
  // The boot theme; a runtime switch rides setTheme (the app theme bridge).
  readonly theme?: Theme;
}

export interface SceneSync {
  // Post the current overlay state (catch-up on the worker `ready`, mirroring layerSync.flushAll).
  readonly flushAll: () => void;
  // Re-resolve the overlay palette from a new theme and repaint (the theme switcher).
  readonly setTheme: (theme: Theme | undefined) => void;
  readonly dispose: () => void;
}

export function installSceneSync(options: SceneSyncOptions): SceneSync {
  const { store, worker, isReady } = options;
  let colors = resolveOverlayColors(options.theme);
  const bridge = createStoreBridge(store, isReady);

  // The readiness gate lives in the bridge (subscribeWhenReady); flushAll is only called post-ready.
  const post = (): void => {
    const { overlay, dataset } = store.getState();
    const request: RenderWorkerRequest = {
      kind: "setSceneOverlay",
      requestId: REQUEST_IDS.scene,
      overlay: buildOverlayPayload(overlay, dataset?.grid ?? null, colors),
    };
    worker.postMessage(request);
  };

  // Overlay flags + density (one selector, identity-skipped in the store) and dataset (bounds change).
  bridge.subscribeWhenReady((state) => state.overlay, post);
  bridge.subscribeWhenReady((state) => state.dataset, post);

  return {
    flushAll: post,
    setTheme(theme) {
      colors = resolveOverlayColors(theme);
      if (isReady()) post();
    },
    dispose: () => bridge.dispose(),
  };
}
