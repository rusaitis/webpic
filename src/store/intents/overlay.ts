import { clamp } from "@schema/math.ts";

// Pure ops for the scene-overlay UI state (axes + grid + gnomon toggles). Mirrors layers.ts /
// colormap.ts: framework-free, node-testable, fresh-object-per-change for subscribeWithSelector, and
// identity-preserving on no-ops (so the app's sceneBridge doesn't re-post on a non-change). Holds only
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
  // The corner CSS gnomon — UI-only (consumed by cameraChrome, not forwarded to render).
  readonly showGnomon: boolean;
  // The draggable point-picker marker (sphere + handles + guides). On by default; the app forwards
  // it to render via pickerBridge when a volume layer is present.
  readonly showPicker: boolean;
  // Target major-tick divisions per axis; the render worker snaps to a 1/2/5 lattice.
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
  return clamp(Math.round(n), GRID_DIVISIONS_MIN, GRID_DIVISIONS_MAX);
}

// The five visibility flags share one setter keyed by field name, so the identity-on-no-op rule
// lives in one place. Keyed rather than five functions: the slice, the panel checkboxes and the
// theme all address a flag by name anyway.
export type OverlayFlag = "showGrid" | "showAxes" | "showLabels" | "showGnomon" | "showPicker";

export function setOverlayFlag(state: OverlayState, flag: OverlayFlag, on: boolean): OverlayState {
  return state[flag] === on ? state : { ...state, [flag]: on };
}

export function setPlane(state: OverlayState, plane: GridPlane, on: boolean): OverlayState {
  return state.planes[plane] === on
    ? state
    : { ...state, planes: { ...state.planes, [plane]: on } };
}

export function setGridDivisions(state: OverlayState, n: number): OverlayState {
  const clamped = clampDivisions(n);
  return state.gridDivisions === clamped ? state : { ...state, gridDivisions: clamped };
}
