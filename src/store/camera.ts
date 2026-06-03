import type { Vec3 } from "@schema/types.ts";

// Store-owned camera pose: the single source of truth the UI mutates (M2.4b orbit/turntable)
// and shader HMR preserves (M2.13). Orbit-spherical, not a THREE.Vector3 — the ui→store→render
// DAG keeps THREE confined to render/. The worker derives the camera position; this restates,
// not shares, the render-side CameraPose (messages.ts), same as WindowLevel.

export interface CameraPose {
  readonly target: Vec3; // look-at point, scene/code units
  readonly azimuth: number; // radians; 0 looks from +z toward the target, increasing toward +x
  readonly elevation: number; // radians from the xz-plane; clamp to ±ELEVATION_LIMIT
  readonly distance: number; // > 0, camera → target
}

// One tick shy of the pole, where azimuth degenerates and the up-axis flips. 4b clamps to this.
export const ELEVATION_LIMIT = Math.PI / 2 - 1e-3;

// Reproduces the legacy static view — position (1.4, 1.1, 1.6) looking at the origin — to ~1e-3.
export const DEFAULT_POSE: CameraPose = {
  target: [0, 0, 0],
  azimuth: 0.7188,
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
// vertical pixels tilt elevation, clamped off the poles. Fresh object so subscribeWithSelector fires.
export function orbitPose(pose: CameraPose, dxPx: number, dyPx: number): CameraPose {
  return {
    target: pose.target,
    azimuth: wrapAngle(pose.azimuth - dxPx * ORBIT_SENS),
    elevation: clamp(pose.elevation - dyPx * ORBIT_SENS, -ELEVATION_LIMIT, ELEVATION_LIMIT),
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
// tracks the cursor at any zoom. Basis from the pose (worldUp = +y): screenRight is the horizontal
// perpendicular to the view azimuth; screenUp reduces to +y when the view is level (elevation 0).
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
    target: [tx + kr * ca - ku * se * sa, ty + ku * ce, tz - kr * sa - ku * se * ca],
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: pose.distance,
  };
}
