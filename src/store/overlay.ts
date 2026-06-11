// Pure ops for the scene-overlay UI state (axes + grid + gnomon toggles). Mirrors layers.ts /
// colormap.ts: framework-free, node-testable, fresh-object-per-change for subscribeWithSelector, and
// identity-preserving on no-ops (so the app's sceneSync doesn't re-post on a non-change). Holds only
// flags + density — colors/bounds are resolved app-side from the theme + dataset, never here.

// THREE-plane terms (what the user sees on the gnomon): under z-up the horizontal/equatorial plane is
// xy (z held). The render worker maps field axes → world by identity; these are drawn-plane names.
export type GridPlane = "xy" | "yz" | "xz";
export const GRID_PLANES: readonly GridPlane[] = ["xy", "yz", "xz"];

export const GRID_DIVISIONS_MIN = 2;
export const GRID_DIVISIONS_MAX = 20;

export interface OverlayState {
  readonly showGrid: boolean;
  readonly planes: Readonly<Record<GridPlane, boolean>>;
  readonly showAxes: boolean;
  readonly showLabels: boolean;
  /** The corner CSS gnomon — UI-only (consumed by cameraChrome, not forwarded to render). */
  readonly showGnomon: boolean;
  /** The draggable point-picker marker (sphere + handles + guides). On by default; the app forwards
   *  it to render via pickerSync when a volume layer is present. */
  readonly showPicker: boolean;
  /** Target major-tick divisions per axis; the render worker snaps to a 1/2/5 lattice. */
  readonly gridDivisions: number;
}

// Equatorial (xy) plane + axes + labels + gnomon on; the other two planes off — the standard
// floor-grid look without boxing the volume in (xy is horizontal under +z-up).
export const DEFAULT_OVERLAY: OverlayState = {
  showGrid: true,
  planes: { xy: true, yz: false, xz: false },
  showAxes: true,
  showLabels: true,
  showGnomon: true,
  showPicker: true,
  gridDivisions: 8,
};

function clampDivisions(n: number): number {
  if (!Number.isFinite(n)) return GRID_DIVISIONS_MIN;
  return Math.max(GRID_DIVISIONS_MIN, Math.min(GRID_DIVISIONS_MAX, Math.round(n)));
}

export function setShowGrid(state: OverlayState, on: boolean): OverlayState {
  return state.showGrid === on ? state : { ...state, showGrid: on };
}

export function setPlane(state: OverlayState, plane: GridPlane, on: boolean): OverlayState {
  return state.planes[plane] === on
    ? state
    : { ...state, planes: { ...state.planes, [plane]: on } };
}

export function setShowAxes(state: OverlayState, on: boolean): OverlayState {
  return state.showAxes === on ? state : { ...state, showAxes: on };
}

export function setShowLabels(state: OverlayState, on: boolean): OverlayState {
  return state.showLabels === on ? state : { ...state, showLabels: on };
}

export function setShowGnomon(state: OverlayState, on: boolean): OverlayState {
  return state.showGnomon === on ? state : { ...state, showGnomon: on };
}

export function setShowPicker(state: OverlayState, on: boolean): OverlayState {
  return state.showPicker === on ? state : { ...state, showPicker: on };
}

export function setGridDivisions(state: OverlayState, n: number): OverlayState {
  const clamped = clampDivisions(n);
  return state.gridDivisions === clamped ? state : { ...state, gridDivisions: clamped };
}
