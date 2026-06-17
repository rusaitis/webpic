import { CAMERA_FOV_DEG, type CameraPose } from "@schema/camera.ts";
import { clamp } from "@schema/math.ts";
import type { Vec3 } from "@schema/types.ts";

// Store-owned camera pose: the single source of truth the UI mutates and shader HMR preserves.
// Orbit-spherical, not a THREE.Vector3 — the ui→store→render DAG keeps THREE confined to render/.
// The pose shape + lens constants live in @schema/camera.ts (the DAG root) so store and render
// share one definition.

export type { CameraMotion, CameraPose, CameraProjection } from "@schema/camera.ts";
export { CAMERA_FOV_DEG, DEFAULT_POSE } from "@schema/camera.ts";

// One tick shy of the ±z pole, where azimuth degenerates and the up-axis flips. Orbit clamps to this.
export const ELEVATION_LIMIT = Math.PI / 2 - 1e-3;

// Dolly bounds for the unit-box scene; well outside the box yet never through the target.
export const DISTANCE_MIN = 0.1;
export const DISTANCE_MAX = 50;

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

// Inertial damping (magviz parity): OrbitControls applies the fraction f of the pending drag per
// update() *call* — and magviz updates per pointermove AND per rAF (~3 calls/frame), so its
// f = 0.035 decays like ≈ 0.10 per 60 fps frame. 0.10 here matches that exactly (τ ≈ 158 ms —
// the long, cinematic gliding stop). dt-normalized so the glide is frame-rate independent:
// pending decays by exp(−λ·dt).
const DAMPING_FACTOR_60FPS = 0.1;
const DAMPING_LAMBDA_PER_MS = -Math.log(1 - DAMPING_FACTOR_60FPS) / (1000 / 60);
// Below this every pending delta is sub-pixel (0.1 px on a ~700 px viewport) — stop the loop.
const MOMENTUM_SETTLED = 1.5e-4;

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
    roll: pose.roll,
  };
}

// Unit view-forward (camera → target) in the z-up orbit basis — the axis a dolly travels and roll
// banks about. The same trig the pick rays and the gnomon use.
export function viewForward(pose: CameraPose): Vec3 {
  const ce = Math.cos(pose.elevation);
  return [-ce * Math.cos(pose.azimuth), -ce * Math.sin(pose.azimuth), -Math.sin(pose.elevation)];
}

// Camera world position — the eye on the orbit sphere: target − distance·viewForward. The inverse of
// the target placement eyeLook does (it holds this point fixed while swinging the look-at around it).
export function cameraPosition(pose: CameraPose): Vec3 {
  const forward = viewForward(pose);
  const [tx, ty, tz] = pose.target;
  return [
    tx - pose.distance * forward[0],
    ty - pose.distance * forward[1],
    tz - pose.distance * forward[2],
  ];
}

// Geometric dolly distance plus the pivot walk that lets a zoom-in fly THROUGH the near limit
// instead of stalling: once the raw distance would drop below DISTANCE_MIN, pin it there and spend
// the leftover zoom as a forward step of the whole rig along the view ray — so close-up motion never
// crawls to zero (you fly into the volume). Zoom-out keeps the hard DISTANCE_MAX clamp. The walked
// pivot stays inside [-DISTANCE_MAX, DISTANCE_MAX]³ so a held key in empty space can't march it to
// f32 infinity. Shared by every dolly entry point (wheel, cursor-anchored wheel, held key).
function dollyWithWalk(pose: CameraPose, rawDistance: number): { distance: number; target: Vec3 } {
  if (rawDistance >= DISTANCE_MIN) {
    return { distance: Math.min(rawDistance, DISTANCE_MAX), target: pose.target };
  }
  const forward = viewForward(pose);
  const step = DISTANCE_MIN - rawDistance; // > 0: the zoom-in distance can't absorb
  const [tx, ty, tz] = pose.target;
  return {
    distance: DISTANCE_MIN,
    target: [
      clamp(tx + forward[0] * step, -DISTANCE_MAX, DISTANCE_MAX),
      clamp(ty + forward[1] * step, -DISTANCE_MAX, DISTANCE_MAX),
      clamp(tz + forward[2] * step, -DISTANCE_MAX, DISTANCE_MAX),
    ],
  };
}

// Wheel deltas arrive in three units (pixel/line/page) and trackpad pinches ride ctrl+wheel with
// tiny per-event deltas; DOLLY_SENS assumes Chrome-style pixels. This is OrbitControls' exact
// normalization (LINE ×16, PAGE ×100, ctrl-pinch ×10) so Firefox line-mode wheels and pinches
// dolly at the same tuned feel — without it a Firefox notch is ~16× too slow.
const WHEEL_LINE_PIXELS = 16;
const WHEEL_PAGE_PIXELS = 100;
const WHEEL_PINCH_GAIN = 10;

export function normalizeWheelDelta(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const pixels =
    deltaMode === 1
      ? deltaY * WHEEL_LINE_PIXELS
      : deltaMode === 2
        ? deltaY * WHEEL_PAGE_PIXELS
        : deltaY;
  return ctrlKey ? pixels * WHEEL_PINCH_GAIN : pixels;
}

// Wheel → dolly: geometric, so each notch is a constant fraction of the current distance.
// Scroll up (deltaY < 0) zooms in (distance shrinks). At the near limit it flies through (dollyWithWalk).
export function dollyPose(pose: CameraPose, wheelDeltaY: number): CameraPose {
  const walked = dollyWithWalk(pose, pose.distance * Math.exp(wheelDeltaY * DOLLY_SENS));
  return {
    target: walked.target,
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: walked.distance,
    roll: pose.roll,
  };
}

// World-space offset of a view-plane displacement: kr along screenRight = (−sa, ca, 0), ku along
// screenUp = (−ca·se, −sa·se, ce) — the z-up orbit basis (worldUp = +z; screenUp reduces to +z when
// level, both ⟂ forward). The one place this trig lives: pan, cursor dolly, and the pick rays
// (pick.cursorRay) all displace through it.
export function viewPlaneOffset(pose: CameraPose, kr: number, ku: number): Vec3 {
  const ce = Math.cos(pose.elevation);
  const se = Math.sin(pose.elevation);
  const sa = Math.sin(pose.azimuth);
  const ca = Math.cos(pose.azimuth);
  return [-kr * sa - ku * ca * se, kr * ca - ku * sa * se, ku * ce];
}

// Wheel → dolly toward the cursor (magviz's zoomToCursor): the world point under the pointer stays
// put on screen. The cursor ray hits the plane through the target ⟂ forward at
// A = target + viewPlaneOffset(D·tan(fov/2)·ndcX·aspect, D·tan(fov/2)·ndcY) — the offset is
// ⟂ forward, so the along-ray distance is exactly D. Scaling camera and target toward A by
// k = newDistance/distance keeps A on the same view ray; azimuth/elevation are untouched.
export function dollyPoseToCursor(
  pose: CameraPose,
  wheelDeltaY: number,
  ndcX: number,
  ndcY: number,
  aspect: number,
): CameraPose {
  const next = dollyPose(pose, wheelDeltaY); // includes the fly-through pivot walk in next.target
  const k = next.distance / pose.distance;
  const reach = (1 - k) * pose.distance * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
  if (reach === 0 || (ndcX === 0 && ndcY === 0)) return next; // clamped or centered → plain dolly
  const o = viewPlaneOffset(pose, reach * ndcX * aspect, reach * ndcY);
  // Anchor offset (distance change down to the clamp) rides on top of the walked pivot, so the
  // cursor stays put down to the near limit and the overflow then flies straight through.
  const [tx, ty, tz] = next.target;
  return {
    target: [tx + o[0], ty + o[1], tz + o[2]],
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: next.distance,
    roll: pose.roll,
  };
}

// Drag → pan (shift/middle/right): slide the look-at target across the view plane. dx/dy are
// viewport-height fractions; the 2·tan(fov/2)·distance scale means the world point under the cursor
// tracks it exactly at any zoom and viewport size (OrbitControls' screen-space pan). Drag-right
// moves the world right ⇒ target slides −screenRight; drag-down moves it down ⇒ +screenUp.
export function panPose(pose: CameraPose, dx: number, dy: number): CameraPose {
  const scale = pose.distance * PAN_WORLD_PER_VIEWPORT;
  const o = viewPlaneOffset(pose, -dx * scale, dy * scale);
  const [tx, ty, tz] = pose.target;
  return {
    target: [tx + o[0], ty + o[1], tz + o[2]],
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: pose.distance,
    roll: pose.roll,
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

// The pose-space displacement a fly-to applies incrementally (magviz's blending tween): per-frame
// eased fractions of this delta land ON TOP of the live pose, so concurrent drags/wheel/momentum
// add instead of being canceled. Every component is additive — azimuth shortest-arc, distance in
// log space (geometric dolly feel) — so fractions summing to 1 reproduce `b` exactly on an
// unperturbed base, and base ⊕ user-input ⊕ delta on a perturbed one.
export interface PoseDelta {
  readonly target: Vec3;
  readonly azimuth: number; // wrapAngle(b − a) — shortest arc, in (−π, π]
  readonly elevation: number;
  readonly logDistance: number; // ln(b/a)
  readonly roll: number; // wrapAngle(b − a) — shortest bank arc
}

export function poseDelta(a: CameraPose, b: CameraPose): PoseDelta {
  return {
    target: [b.target[0] - a.target[0], b.target[1] - a.target[1], b.target[2] - a.target[2]],
    azimuth: wrapAngle(b.azimuth - a.azimuth),
    elevation: b.elevation - a.elevation,
    logDistance: Math.log(b.distance / a.distance),
    roll: wrapAngle(b.roll - a.roll),
  };
}

// Clamps are no-ops for any fraction of a valid-pose→valid-pose delta; they only bite when blended
// user input has already pushed the base against a limit (same behavior as a clamped drag).
export function applyPoseDelta(pose: CameraPose, delta: PoseDelta, fraction: number): CameraPose {
  const [tx, ty, tz] = pose.target;
  return {
    target: [
      tx + delta.target[0] * fraction,
      ty + delta.target[1] * fraction,
      tz + delta.target[2] * fraction,
    ],
    azimuth: wrapAngle(pose.azimuth + delta.azimuth * fraction),
    elevation: clamp(
      pose.elevation + delta.elevation * fraction,
      -ELEVATION_LIMIT,
      ELEVATION_LIMIT,
    ),
    distance: clamp(
      pose.distance * Math.exp(delta.logDistance * fraction),
      DISTANCE_MIN,
      DISTANCE_MAX,
    ),
    roll: wrapAngle(pose.roll + delta.roll * fraction),
  };
}

// Held-key camera motion: constant velocity, dt-scaled — NOT the momentum impulses (key repeat
// rates vary by OS; feeding repeats as impulses gives a stuttery, rate-dependent glide, while a
// held key wants flat velocity with a hard stop on release). Rates match magviz's keyboard orbit.
export interface KeyNudge {
  readonly azimuth: -1 | 0 | 1; // +1 sweeps the camera CCW about +z (view pans right)
  readonly elevation: -1 | 0 | 1; // +1 lifts toward +z
  readonly dolly: -1 | 0 | 1; // +1 zooms in (distance shrinks, geometric, flies through the wall)
  readonly roll: -1 | 0 | 1; // +1 banks the view clockwise (camera rolls right)
}

const KEY_ORBIT_RAD_PER_SEC = 1.2;
const KEY_DOLLY_PER_SEC = 1.5; // fraction-of-distance per second — never fights the clamps
const KEY_ROLL_RAD_PER_SEC = 1.0; // gentler than orbit — banking is a fine adjustment

// First-person look: hold the eye fixed and swing the look-at around it (azimuth/elevation deltas),
// moving the target so the camera stays put — target = eye + distance·viewForward(new angles), the
// inverse of cameraPosition. Distance/roll preserved. The pivot is the *eye*, not the target, so in
// fly mode A/D/Q/E turn the view in place instead of orbiting a pivot that, up close, sits at your face.
function eyeLook(pose: CameraPose, dAzimuth: number, dElevation: number): CameraPose {
  const azimuth = wrapAngle(pose.azimuth + dAzimuth);
  const elevation = clamp(pose.elevation + dElevation, -ELEVATION_LIMIT, ELEVATION_LIMIT);
  const eye = cameraPosition(pose);
  const forward = viewForward({ ...pose, azimuth, elevation });
  return {
    ...pose,
    azimuth,
    elevation,
    target: [
      eye[0] + pose.distance * forward[0],
      eye[1] + pose.distance * forward[1],
      eye[2] + pose.distance * forward[2],
    ],
  };
}

// `lookMode` (fly mode — the deliberate `isFlyMode` toggle, not proximity) reinterprets A/D/Q/E as
// first-person look: the view swings around the eye with *flipped* handedness (D turns right, E looks
// up) instead of orbiting the target. The flip is the fix, not the pivot — viewForward depends only on
// the angles, so the same azimuth delta turns the view the same way regardless of pivot; orbit only
// *reads* right when the eye's translation dominates the facing rotation (far from the target). Dolly
// + roll are identical either way, so rotate first, then share the dolly-walk + roll tail.
export function nudgePose(
  pose: CameraPose,
  nudge: KeyNudge,
  dtMs: number,
  lookMode = false,
): CameraPose {
  const dt = Math.max(dtMs, 0) / 1000;
  const rot = KEY_ORBIT_RAD_PER_SEC * dt;
  const rotated = lookMode
    ? eyeLook(pose, -nudge.azimuth * rot, -nudge.elevation * rot)
    : {
        ...pose,
        azimuth: wrapAngle(pose.azimuth + nudge.azimuth * rot),
        elevation: clamp(pose.elevation + nudge.elevation * rot, -ELEVATION_LIMIT, ELEVATION_LIMIT),
      };
  const walked = dollyWithWalk(
    rotated,
    rotated.distance * Math.exp(-nudge.dolly * KEY_DOLLY_PER_SEC * dt),
  );
  return {
    target: walked.target,
    azimuth: rotated.azimuth,
    elevation: rotated.elevation,
    distance: walked.distance,
    roll: wrapAngle(pose.roll + nudge.roll * KEY_ROLL_RAD_PER_SEC * dt),
  };
}

// What a one-shot camera fly intent asks for: an explicit pose (gnomon snaps, reset) or a fit of
// the data bounds — resolved by ui/pointerCamera, the only consumer that knows the canvas aspect.
export type CameraFlyTarget =
  | { readonly kind: "pose"; readonly pose: CameraPose }
  | { readonly kind: "fit" };

// Bounding sphere of the unit render box [-0.5, 0.5]³ — the volume's object-space extent until
// non-cube datasets land (poseForBounds takes a sphere so they only need a different one).
export const UNIT_BOX_RADIUS = Math.sqrt(3) / 2;

export interface BoundingSphere {
  readonly center: Vec3;
  readonly radius: number; // > 0, scene units
}

// Breathing room so the fitted sphere doesn't kiss the viewport edges.
const FIT_PADDING = 1.06;

// Frame the sphere: keep the viewing direction, recenter on it, and back off until it fits both
// frustum extents. distance = r/sin(θ) — not r/tan(θ) — puts the frustum side planes tangent to
// the sphere, so every point of it projects inside NDC (r/tan only bounds the central disc).
export function poseForBounds(
  pose: CameraPose,
  sphere: BoundingSphere,
  aspect: number,
): CameraPose {
  const halfV = (CAMERA_FOV_DEG * Math.PI) / 360;
  const safeAspect = Math.max(aspect, 1e-6);
  // The limiting half-angle: vertical in landscape, horizontal (tan scales with aspect) in portrait.
  const halfMin = safeAspect >= 1 ? halfV : Math.atan(Math.tan(halfV) * safeAspect);
  const distance = clamp(
    (sphere.radius * FIT_PADDING) / Math.sin(halfMin),
    DISTANCE_MIN,
    DISTANCE_MAX,
  );
  // Fit levels the horizon: a framed overview should be upright, not banked.
  return {
    target: sphere.center,
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance,
    roll: 0,
  };
}

// Compact pose ⇄ URL-param string ("az,el,d,tx,ty,tz", radians, 4 decimals — finer than the HUD's
// readout, so a shared link reproduces the view it displayed). Parse normalizes through the same
// invariants the pointer path enforces and returns null for anything malformed (caller ignores).
const POSE_PARAM_DECIMALS = 4;

export function formatPoseParam(pose: CameraPose): string {
  const [tx, ty, tz] = pose.target;
  return [pose.azimuth, pose.elevation, pose.distance, tx, ty, tz, pose.roll]
    .map((v) => v.toFixed(POSE_PARAM_DECIMALS))
    .join(",");
}

export function parsePoseParam(raw: string): CameraPose | null {
  const parts = raw.split(",");
  if (parts.length !== 6 && parts.length !== 7) return null; // 6 = pre-roll links (roll defaults 0)
  const numbers = parts.map(Number);
  if (numbers.some((v) => !Number.isFinite(v))) return null;
  const [azimuth = 0, elevation = 0, distance = 0, tx = 0, ty = 0, tz = 0, roll = 0] = numbers;
  if (distance <= 0) return null;
  // Targets clamp too (URL input is a trust boundary): a huge crafted target overflows the
  // render-side far-plane math (hypot → Inf → NaN projection matrix) and f32 GPU uniforms.
  const t = (v: number): number => clamp(v, -DISTANCE_MAX, DISTANCE_MAX);
  return {
    target: [t(tx), t(ty), t(tz)],
    azimuth: wrapAngle(azimuth),
    elevation: clamp(elevation, -ELEVATION_LIMIT, ELEVATION_LIMIT),
    distance: clamp(distance, DISTANCE_MIN, DISTANCE_MAX),
    roll: wrapAngle(roll),
  };
}

export type AxisView = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

// Axis-aligned snap target (gnomon tip clicks): look down the named world axis at the current
// target, distance preserved — magviz's ViewHelper behavior. ±z keeps the current azimuth (the
// camera tips straight over, no surprise spin) and clamps at ELEVATION_LIMIT, so the up vector
// never crosses the pole.
// Axis snaps level the horizon (roll: 0) so each canonical view is upright.
export function axisViewPose(view: AxisView, pose: CameraPose): CameraPose {
  switch (view) {
    case "+x":
      return { ...pose, azimuth: 0, elevation: 0, roll: 0 };
    case "-x":
      return { ...pose, azimuth: Math.PI, elevation: 0, roll: 0 };
    case "+y":
      return { ...pose, azimuth: Math.PI / 2, elevation: 0, roll: 0 };
    case "-y":
      return { ...pose, azimuth: -Math.PI / 2, elevation: 0, roll: 0 };
    case "+z":
      return { ...pose, elevation: ELEVATION_LIMIT, roll: 0 };
    case "-z":
      return { ...pose, elevation: -ELEVATION_LIMIT, roll: 0 };
  }
}
