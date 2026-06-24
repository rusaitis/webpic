import {
  CAMERA_FOV_DEG,
  CAMERA_HALF_FOV_TAN,
  cameraPosition,
  DEFAULT_POSE,
} from "@schema/camera.ts";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { FRUSTUM } from "../constants.ts";
import type { CameraPose } from "../messages.ts";

// The render worker owns the cameras (lifted out of the scene factories so the store-owned pose
// drives them and shader HMR can rebuild a scene without losing the view). This is the one place
// THREE camera math lives. Pose shape + lens constants are shared via @schema/camera.ts.

export { DEFAULT_POSE };

// Near clip for both volume cameras (matches the legacy raymarchScene camera). Distinct from
// FRUSTUM.near (the screen-aligned slice/boot ortho). The far args below are init placeholders —
// applyPose/applyPoseOrtho size far per pose so the dolly range never far-clips.
const VOLUME_NEAR = 0.01;

// Perspective camera for the volume raymarcher.
export function createPerspectiveCamera(aspect = 1): PerspectiveCamera {
  return new PerspectiveCamera(CAMERA_FOV_DEG, aspect, VOLUME_NEAR, 10);
}

// Screen-aligned orthographic camera for the slice + boot triangle: fixed straight-on, pose-invariant
// (orbiting an axis-aligned 2D slice is meaningless). Matches the legacy slice/test camera exactly.
export function createOrthographicCamera(): OrthographicCamera {
  const camera = new OrthographicCamera(
    FRUSTUM.left,
    FRUSTUM.right,
    FRUSTUM.top,
    FRUSTUM.bottom,
    FRUSTUM.near,
    FRUSTUM.far,
  );
  camera.position.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  return camera;
}

// Everything drawn fits in this radius of the world origin: the unit box's half-diagonal
// (√3/2 ≈ 0.87, box centered at the origin) plus the overlay labels just outside it, rounded up.
const SCENE_RADIUS = 1;

// Reused per placeCamera() call (render-hot — no per-frame Vector3 churn).
const FORWARD = new Vector3();
const UP = new Vector3();

// Orbit-spherical placement shared by both volume cameras. z-up (world=physical): azimuth sweeps
// the xy-plane (0 → +x, increasing toward +y, CCW about +z), elevation lifts toward +z. `roll` banks
// the up vector about the view-forward axis (0 = level world +z).
function placeCamera(camera: PerspectiveCamera | OrthographicCamera, pose: CameraPose): void {
  const [tx, ty, tz] = pose.target;
  const eye = cameraPosition(pose);
  camera.position.set(eye[0], eye[1], eye[2]);
  if (pose.roll === 0) {
    camera.up.set(0, 0, 1);
  } else {
    // Bank: world +z rotated about the unit view-forward (camera → target) by roll.
    FORWARD.set(tx, ty, tz).sub(camera.position).normalize();
    camera.up.copy(UP.set(0, 0, 1).applyAxisAngle(FORWARD, pose.roll));
  }
  camera.lookAt(tx, ty, tz);
}

// far follows the pose (distance + |target| + scene radius) so the full dolly range stays
// renderable — a fixed far ≪ DISTANCE_MAX far-clipped the scene into a void on zoom-out.
function poseFar(pose: CameraPose): number {
  const [tx, ty, tz] = pose.target;
  return pose.distance + Math.hypot(tx, ty, tz) + SCENE_RADIUS; // |target| covers a panned box
}

// Orbit-spherical → THREE perspective camera. The raymarch shader reads
// cameraPosition/modelWorldMatrixInverse, refreshed during render(), so a repaint right after this
// is sufficient.
export function applyPose(camera: PerspectiveCamera, pose: CameraPose, aspect = 1): void {
  placeCamera(camera, pose);
  const far = poseFar(pose);
  if (camera.aspect !== aspect || camera.far !== far) {
    camera.aspect = aspect;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

// Pose-driven orthographic camera for the volume view (distinct from the screen-aligned slice
// ortho). near matches the perspective camera; far is applied per pose, like applyPose.
export function createVolumeOrthographicCamera(aspect = 1): OrthographicCamera {
  const camera = new OrthographicCamera(-aspect, aspect, 1, -1, VOLUME_NEAR, 10);
  applyPoseOrtho(camera, DEFAULT_POSE, aspect);
  return camera;
}

// Matched frustum: halfH = distance·tan(fov/2) shows the perspective view's extent at the target
// plane, so flipping projection keeps the on-screen scale (only parallax changes) and `distance`
// stays the single zoom parameter (the frustum follows it).
export function applyPoseOrtho(camera: OrthographicCamera, pose: CameraPose, aspect = 1): void {
  placeCamera(camera, pose);
  const halfH = pose.distance * CAMERA_HALF_FOV_TAN;
  camera.left = -halfH * aspect;
  camera.right = halfH * aspect;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.far = poseFar(pose);
  camera.updateProjectionMatrix(); // the frustum follows distance — no change guard pays off
}
