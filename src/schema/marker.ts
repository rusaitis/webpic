import { type CameraPose, DEFAULT_POSE } from "./camera.ts";
import type { Vec3 } from "./types.ts";

// Point-picker marker geometry + the camera-pose gating that drives its rendering (render/) and drag
// interaction (store/ + ui/). Shared here in schema since render and store can't import each other.
//
// All lengths are object space: the volume is the unit box [-0.5, 0.5]³ with identity transform, so
// object = world. z-up adaptation of magviz's y-up picker: "vertical" drag is world z, the equatorial
// plane is xy (z held), and the cross-screen axis is world x or y.

// Which part of the marker the cursor is over / grabbing. "vertical" = the ↕ (z) handle; "horizontal"
// = the ↔ (x or y) handle.
export type MarkerPart = "none" | "core" | "vertical" | "horizontal";

// What a cursor-ray pick is for: "place" moves the picker marker to the point; "focus" additionally
// flies the orbit pivot there. Both use the same opacity-weighted ray march (render/pickRay).
export type PickPurpose = "place" | "focus";

// The world axis the ↔ handle drags along in the equatorial regime.
export type HandleAxis = "x" | "y";

// Core sphere radius, object space. The ring + handles are children scaled with the core, so this
// also sets their absolute size via the *_SCALE factors below.
export const MARKER_SPHERE_RADIUS = 0.012;
// Knob distance from the core, and knob sprite size, as multiples of the sphere radius (magviz tunables).
export const HANDLE_OFFSET_SCALE = 8.5;
export const HANDLE_KNOB_SCALE = 2.7;

// Zoom-aware sizing: scale the core per frame by a damped function of camera distance, so it doesn't
// read huge up close and a speck far out. ZOOM_DAMP 0 = world-fixed, 1 = constant on-screen.
export const ZOOM_DAMP = 0.7;
export const ZOOM_SCALE_MIN = 0.5;
export const ZOOM_SCALE_MAX = 3.5;
export const REFERENCE_VIEW_DISTANCE = DEFAULT_POSE.distance;

// Drag-axis gating by camera elevation θ above the equatorial (xy) plane (0° edge-on, 90° top-down).
// Vertical (z) drag degenerates near 90°; the free xy-plane drag degenerates near 0°.
export const VERTICAL_MAX_ELEV_DEG = 60; // above this, the ↕ handle fades out (vertical disabled)
export const HORIZONTAL_MIN_ELEV_DEG = 15; // below this, the free xy-plane gives way to the ↔ axis
// When the view azimuth is within this many degrees of a world axis the *other* horizontal axis is
// cleanly cross-screen; the ~45° diagonal beyond this is ambiguous (no ↔ handle).
export const AZIMUTH_ALIGN_MAX_DEG = 40;

const DEG_PER_RAD = 180 / Math.PI;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

// Camera position implied by the orbit pose (same basis as store/pick.cursorRay and render/camera).
function cameraPosition(pose: CameraPose): Vec3 {
  const ce = Math.cos(pose.elevation);
  const se = Math.sin(pose.elevation);
  const [tx, ty, tz] = pose.target;
  const d = pose.distance;
  return [tx + d * ce * Math.cos(pose.azimuth), ty + d * ce * Math.sin(pose.azimuth), tz + d * se];
}

// Zoom-tracking world scale for the core (and its ring/handle children). Perspective keys off the
// true camera→point distance; orthographic keys off the orbit distance alone — its matched frustum
// (halfH = d·tan(fov/2)) makes apparent size depend on d, not on the point's depth.
export function markerCoreScale(pose: CameraPose, point: Vec3, orthographic: boolean): number {
  let dist: number;
  if (orthographic) {
    dist = pose.distance;
  } else {
    const cam = cameraPosition(pose);
    dist = Math.hypot(cam[0] - point[0], cam[1] - point[1], cam[2] - point[2]);
  }
  return clamp((dist / REFERENCE_VIEW_DISTANCE) ** ZOOM_DAMP, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX);
}

// Knob distance from the core in world units (the handle stem length), accounting for the zoom scale
// the handle inherits as a child of the core.
export function markerHandleOffset(pose: CameraPose, point: Vec3, orthographic: boolean): number {
  return MARKER_SPHERE_RADIUS * HANDLE_OFFSET_SCALE * markerCoreScale(pose, point, orthographic);
}

// Camera elevation above the equatorial plane, degrees: 0° edge-on, 90° top-down. The pose carries
// elevation explicitly, so no view-direction trig is needed (unlike magviz).
export function cameraElevationDeg(pose: CameraPose): number {
  return Math.abs(pose.elevation) * DEG_PER_RAD;
}

// Whether vertical (z) drag is usable at the current view angle.
export function verticalDragAllowed(pose: CameraPose): boolean {
  return cameraElevationDeg(pose) <= VERTICAL_MAX_ELEV_DEG;
}

// Whether the free xy-plane drag is usable; below this the equatorial (vertical + single axis) regime
// takes over.
export function horizontalDragAllowed(pose: CameraPose): boolean {
  return cameraElevationDeg(pose) >= HORIZONTAL_MIN_ELEV_DEG;
}

// The single cross-screen horizontal world axis to drag along in the equatorial regime, or null when
// the view sits in the ~45° diagonal band (neither axis is cleanly cross-screen). Depends only on
// azimuth: the forward horizontal direction is (cos az, sin az); the larger component is into-screen,
// so the smaller-component axis is the cross-screen one to drag.
export function horizontalDragAxis(pose: CameraPose): HandleAxis | null {
  const ax = Math.abs(Math.cos(pose.azimuth));
  const ay = Math.abs(Math.sin(pose.azimuth));
  const hi = Math.max(ax, ay);
  if (hi < 1e-4) return null; // degenerate (shouldn't occur in the equatorial regime) — no axis
  const phi = Math.atan2(Math.min(ax, ay), hi) * DEG_PER_RAD;
  if (phi > AZIMUTH_ALIGN_MAX_DEG) return null;
  return ax >= ay ? "y" : "x";
}
