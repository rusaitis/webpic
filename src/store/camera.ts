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

// Vertical field of view. render/camera.ts createPerspectiveCamera restates this (the layers
// share no module) — keep the two in sync. ui needs it for the zoom-to-cursor ray math.
export const CAMERA_FOV_DEG = 45;

// Pointer sensitivities, in OrbitControls' exact units so webpic matches the magviz feel at any
// viewport size. Drag deltas arrive as *viewport-height fractions* (px / viewport height px —
// ui/pointerCamera normalizes); wheel deltas stay raw. All tunable math lives here so
// ui/pointerCamera carries none.
const ORBIT_SENS = 2 * Math.PI; // rad per viewport-height of drag (OrbitControls rotateSpeed 1)
// OrbitControls dollies 0.95^(|ΔY|/100) per wheel event; this is the same curve in geometric-exp
// form (≈ ×0.94 per 120-unit notch) — uniform zoom feel at any distance, magviz parity.
const DOLLY_SENS = Math.log(1 / 0.95) / 100;
// World units per (distance × viewport-height fraction): 2·tan(fov/2) makes a panned world point
// track the cursor exactly — OrbitControls' screen-space pan.
const PAN_WORLD_PER_VIEWPORT = 2 * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

// Inertial damping (magviz feel, tuned springier): OrbitControls applies the fraction f of the
// pending drag per update() *call* — and magviz updates per pointermove AND per rAF (~3
// calls/frame), so its f = 0.035 decays like ≈ 0.10 per 60 fps frame. This loop is pure-rAF;
// 0.15 sits a notch quicker than that (τ ≈ 100 ms — snap with a hint of glide). dt-normalized so
// the glide is frame-rate independent: pending decays by exp(−λ·dt).
const DAMPING_FACTOR_60FPS = 0.15;
const DAMPING_LAMBDA_PER_MS = -Math.log(1 - DAMPING_FACTOR_60FPS) / (1000 / 60);
// Below this every pending delta is sub-pixel (0.1 px on a ~700 px viewport) — stop the loop.
const MOMENTUM_SETTLED = 1.5e-4;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

// Keep azimuth in (-π, π] so the readout stays bounded as a drag accumulates turns.
function wrapAngle(angle: number): number {
  const twoPi = 2 * Math.PI;
  return ((((angle + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

// Drag → orbit: horizontal drag spins azimuth (grab-and-spin — drag right turns the view right),
// vertical drag tilts elevation, clamped off the poles. Drag down raises elevation (camera rises to
// look down on top), matching three's OrbitControls — as does the unit: dx/dy are viewport-height
// fractions, so a full-height drag is a full revolution. Fresh object so subscribeWithSelector fires.
export function orbitPose(pose: CameraPose, dx: number, dy: number): CameraPose {
  return {
    target: pose.target,
    azimuth: wrapAngle(pose.azimuth - dx * ORBIT_SENS),
    elevation: clamp(pose.elevation + dy * ORBIT_SENS, -ELEVATION_LIMIT, ELEVATION_LIMIT),
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

// Wheel → dolly toward the cursor (magviz's zoomToCursor): the world point under the pointer stays
// put on screen. The cursor ray hits the plane through the target ⟂ forward at
// A = target + D·tan(fov/2)·(ndcY·screenUp + ndcX·aspect·screenRight) — screenRight/screenUp are
// ⟂ forward, so the along-ray distance is exactly D. Scaling camera and target toward A by
// k = newDistance/distance keeps A on the same view ray; azimuth/elevation are untouched.
export function dollyPoseToCursor(
  pose: CameraPose,
  wheelDeltaY: number,
  ndcX: number,
  ndcY: number,
  aspect: number,
): CameraPose {
  const next = dollyPose(pose, wheelDeltaY);
  const k = next.distance / pose.distance;
  const reach = (1 - k) * pose.distance * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
  if (reach === 0 || (ndcX === 0 && ndcY === 0)) return next; // clamped or centered → plain dolly
  const ce = Math.cos(pose.elevation);
  const se = Math.sin(pose.elevation);
  const sa = Math.sin(pose.azimuth);
  const ca = Math.cos(pose.azimuth);
  const kr = reach * ndcX * aspect; // along screenRight = (−sa, ca, 0)
  const ku = reach * ndcY; // along screenUp = (−ca·se, −sa·se, ce)
  const [tx, ty, tz] = pose.target;
  return {
    target: [tx - kr * sa - ku * ca * se, ty + kr * ca - ku * sa * se, tz + ku * ce],
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: next.distance,
  };
}

// Drag → pan (shift/middle/right): slide the look-at target across the view plane. dx/dy are
// viewport-height fractions; the 2·tan(fov/2)·distance scale means the world point under the cursor
// tracks it exactly at any zoom and viewport size (OrbitControls' screen-space pan). z-up basis
// (worldUp = +z): screenRight = (−sa, ca, 0) (horizontal, ⟂ to the view azimuth); screenUp =
// (−ca·se, −sa·se, ce) (reduces to +z when level). Drag-right moves the world right ⇒ target slides
// −screenRight; drag-down moves it down ⇒ target slides +screenUp.
export function panPose(pose: CameraPose, dx: number, dy: number): CameraPose {
  const ce = Math.cos(pose.elevation);
  const se = Math.sin(pose.elevation);
  const sa = Math.sin(pose.azimuth);
  const ca = Math.cos(pose.azimuth);
  const scale = pose.distance * PAN_WORLD_PER_VIEWPORT;
  const kr = -dx * scale; // drag right pushes the world right ⇒ target slides left
  const ku = dy * scale; // drag down pushes the world down ⇒ target slides up
  const [tx, ty, tz] = pose.target;
  return {
    target: [tx - kr * sa - ku * ca * se, ty + kr * ca - ku * sa * se, tz + ku * ce],
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: pose.distance,
  };
}

// Pending drag deltas not yet applied to the pose — the damped-glide state. Viewport-height
// fractions, the same unit the orbit/pan helpers take, so a step is just those helpers fed the
// released fraction. Held by ui/pointerCamera between frames; pure here so the glide is unit-testable.
export interface CameraMomentum {
  readonly orbitDx: number;
  readonly orbitDy: number;
  readonly panDx: number;
  readonly panDy: number;
}

export const MOMENTUM_ZERO: CameraMomentum = { orbitDx: 0, orbitDy: 0, panDx: 0, panDy: 0 };

export function addOrbitMomentum(momentum: CameraMomentum, dx: number, dy: number): CameraMomentum {
  return { ...momentum, orbitDx: momentum.orbitDx + dx, orbitDy: momentum.orbitDy + dy };
}

export function addPanMomentum(momentum: CameraMomentum, dx: number, dy: number): CameraMomentum {
  return { ...momentum, panDx: momentum.panDx + dx, panDy: momentum.panDy + dy };
}

export function isMomentumSettled(momentum: CameraMomentum): boolean {
  return (
    Math.abs(momentum.orbitDx) < MOMENTUM_SETTLED &&
    Math.abs(momentum.orbitDy) < MOMENTUM_SETTLED &&
    Math.abs(momentum.panDx) < MOMENTUM_SETTLED &&
    Math.abs(momentum.panDy) < MOMENTUM_SETTLED
  );
}

// One glide frame: apply the (1 − exp(−λ·dt)) fraction of every pending delta through the orbit/pan
// helpers (clamps included) and keep the decayed remainder. The released fractions sum to the full
// pending delta over the glide, so a drag lands exactly where an undamped one would.
export function stepMomentum(
  pose: CameraPose,
  momentum: CameraMomentum,
  dtMs: number,
): { pose: CameraPose; momentum: CameraMomentum } {
  const keep = Math.exp(-DAMPING_LAMBDA_PER_MS * Math.max(dtMs, 0));
  const release = 1 - keep;
  let next = pose;
  if (momentum.orbitDx !== 0 || momentum.orbitDy !== 0) {
    next = orbitPose(next, momentum.orbitDx * release, momentum.orbitDy * release);
  }
  if (momentum.panDx !== 0 || momentum.panDy !== 0) {
    next = panPose(next, momentum.panDx * release, momentum.panDy * release);
  }
  return {
    pose: next,
    momentum: {
      orbitDx: momentum.orbitDx * keep,
      orbitDy: momentum.orbitDy * keep,
      panDx: momentum.panDx * keep,
      panDy: momentum.panDy * keep,
    },
  };
}

// Pinch → dolly: the wheel-delta whose dollyPose/dollyPoseToCursor effect multiplies distance by
// `scale`, so a two-finger pinch reuses the wheel path (including its cursor/centroid anchoring)
// instead of duplicating the clamp + anchor math. scale = previousSpread / currentSpread.
export function dollyDeltaForScale(scale: number): number {
  return Math.log(scale) / DOLLY_SENS;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// Pose interpolation for the reset / axis-snap tween: shortest-arc azimuth (a 350°→10° fly-to turns
// 20°, not −340°), geometric distance (uniform zoom feel — matches the dolly curve), linear
// elevation/target. Callers snap to `b` exactly at t = 1 (the exp/log round-trip is ~1 ulp off).
export function poseLerp(a: CameraPose, b: CameraPose, t: number): CameraPose {
  const azDelta = wrapAngle(b.azimuth - a.azimuth);
  const [ax, ay, az] = a.target;
  const [bx, by, bz] = b.target;
  return {
    target: [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t],
    azimuth: wrapAngle(a.azimuth + azDelta * t),
    elevation: a.elevation + (b.elevation - a.elevation) * t,
    distance: Math.exp(Math.log(a.distance) * (1 - t) + Math.log(b.distance) * t),
  };
}

export type AxisView = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

// Axis-aligned snap target (gnomon tip clicks): look down the named world axis at the current
// target, distance preserved — magviz's ViewHelper behavior. ±z keeps the current azimuth (the
// camera tips straight over, no surprise spin) and clamps at ELEVATION_LIMIT, so the up vector
// never crosses the pole.
export function axisViewPose(view: AxisView, pose: CameraPose): CameraPose {
  switch (view) {
    case "+x":
      return { ...pose, azimuth: 0, elevation: 0 };
    case "-x":
      return { ...pose, azimuth: Math.PI, elevation: 0 };
    case "+y":
      return { ...pose, azimuth: Math.PI / 2, elevation: 0 };
    case "-y":
      return { ...pose, azimuth: -Math.PI / 2, elevation: 0 };
    case "+z":
      return { ...pose, elevation: ELEVATION_LIMIT };
    case "-z":
      return { ...pose, elevation: -ELEVATION_LIMIT };
  }
}
