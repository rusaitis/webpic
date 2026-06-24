import type { Vec3 } from "./types.ts";

// The orbit camera pose, shared across the ui→store→render boundary (schema is the DAG root all
// three import).

export interface CameraPose {
  readonly target: Vec3; // look-at point, scene/code units
  readonly azimuth: number; // radians; 0 looks from +x toward the target, increasing toward +y (CCW about +z)
  readonly elevation: number; // radians from the xy-plane toward +z
  readonly distance: number; // > 0, camera → target
  readonly roll: number; // radians, banking about the view-forward axis; 0 = level (world +z up)
}

// Volume-view projection (slices are always screen-aligned ortho).
export type CameraProjection = "perspective" | "orthographic";

// Camera-motion liveness, ui → store → worker. "gesture" = the hand is on the camera (drag, held
// key, fresh wheel, momentum glide) — march coarse for responsiveness; "fly" = a machine-driven
// eased flight — predictable and short, so it earns a gentler quality tier (full resolution,
// mildly coarser march); "idle" = settle back to full quality.
export type CameraMotion = "idle" | "gesture" | "fly";

// Vertical field of view. The store's zoom-to-cursor/pan ray math and the render-side perspective
// camera must agree on this, or the world point under the cursor drifts during a dolly.
export const CAMERA_FOV_DEG = 45;

// Half-FOV tangent — tan(fov/2). The store's pan/zoom-to-cursor ray math and the render-side
// perspective + volume-ortho cameras all scale by this; they must share one value or the world
// point under the cursor drifts.
export const CAMERA_HALF_FOV_TAN = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

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

// z-up 3/4 view aimed at the box center; boots with the volume near-filling the frame, axes readable.
export const DEFAULT_POSE: CameraPose = {
  target: [0, 0, 0],
  azimuth: Math.PI / 4,
  elevation: 0.6,
  distance: 2.25,
  roll: 0,
};
