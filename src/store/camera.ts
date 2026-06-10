import type { Vec3 } from "@schema/types.ts";

// Store-owned camera pose: the single source of truth the UI mutates (M2.4b orbit/turntable)
// and shader HMR preserves (M2.13). Orbit-spherical, not a THREE.Vector3 — the ui→store→render
// DAG keeps THREE confined to render/. The worker derives the camera position; this restates,
// not shares, the render-side CameraPose (messages.ts), same as WindowLevel.

export interface CameraPose {
  readonly target: Vec3; // look-at point, scene/code units
  readonly azimuth: number; // radians; 0 looks from +x toward the target, increasing toward +y (CCW about +z)
  readonly elevation: number; // radians from the xy-plane toward +z; clamp to ±ELEVATION_LIMIT
  readonly distance: number; // > 0, camera → target
}

// One tick shy of the ±z pole, where azimuth degenerates and the up-axis flips. 4b clamps to this.
export const ELEVATION_LIMIT = Math.PI / 2 - 1e-3;

// z-up 3/4 view — position ≈ (1.50, 1.50, 1.10) looking at the origin, +z up.
export const DEFAULT_POSE: CameraPose = {
  target: [0, 0, 0],
  azimuth: Math.PI / 4,
  elevation: 0.4773,
  distance: 2.3937,
};

// Dolly bounds for the unit-box scene; well outside the box yet never through the target.
export const DISTANCE_MIN = 0.1;
export const DISTANCE_MAX = 50;

// Pointer sensitivities. All tunable math lives here so ui/pointerCamera carries none — it just
// forwards raw pixel/wheel deltas. Screen-relative, so the feel is resolution-independent enough.
const ORBIT_SENS = 0.005; // rad / px
const DOLLY_SENS = 0.0015; // per wheel-delta unit (geometric → uniform zoom feel at any distance)
const PAN_SENS = 0.0015; // screen-fraction / px, scaled by distance so the world tracks the cursor

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

// Keep azimuth in (-π, π] so the readout stays bounded as a drag accumulates turns.
function wrapAngle(angle: number): number {
  const twoPi = 2 * Math.PI;
  return ((((angle + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

// Drag → orbit: horizontal pixels spin azimuth (grab-and-spin — drag right turns the view right),
// vertical pixels tilt elevation, clamped off the poles. Drag down raises elevation (camera rises to
// look down on top), matching three's OrbitControls. Fresh object so subscribeWithSelector fires.
export function orbitPose(pose: CameraPose, dxPx: number, dyPx: number): CameraPose {
  return {
    target: pose.target,
    azimuth: wrapAngle(pose.azimuth - dxPx * ORBIT_SENS),
    elevation: clamp(pose.elevation + dyPx * ORBIT_SENS, -ELEVATION_LIMIT, ELEVATION_LIMIT),
    distance: pose.distance,
  };
}

// Wheel → dolly: geometric, so each notch is a constant fraction of the current distance.
// Scroll up (deltaY < 0) zooms in (distance shrinks). Clamped to the dolly bounds.
export function dollyPose(pose: CameraPose, wheelDeltaY: number): CameraPose {
  return {
    target: pose.target,
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: clamp(pose.distance * Math.exp(wheelDeltaY * DOLLY_SENS), DISTANCE_MIN, DISTANCE_MAX),
  };
}

// Shift-drag → pan: slide the look-at target across the view plane, scaled by distance so the world
// tracks the cursor at any zoom. z-up basis (worldUp = +z): screenRight = (−sa, ca, 0) (horizontal,
// ⟂ to the view azimuth); screenUp = (−ca·se, −sa·se, ce) (reduces to +z when level). Drag-right moves
// the world right ⇒ target slides −screenRight; drag-down moves it down ⇒ target slides +screenUp.
export function panPose(pose: CameraPose, dxPx: number, dyPx: number): CameraPose {
  const ce = Math.cos(pose.elevation);
  const se = Math.sin(pose.elevation);
  const sa = Math.sin(pose.azimuth);
  const ca = Math.cos(pose.azimuth);
  const scale = pose.distance * PAN_SENS;
  const kr = -dxPx * scale; // drag right pushes the world right ⇒ target slides left
  const ku = dyPx * scale; // drag down pushes the world down ⇒ target slides up
  const [tx, ty, tz] = pose.target;
  return {
    target: [tx - kr * sa - ku * ca * se, ty + kr * ca - ku * sa * se, tz + ku * ce],
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: pose.distance,
  };
}
