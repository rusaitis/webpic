import { CAMERA_FOV_DEG, DEFAULT_POSE } from "@schema/camera.ts";
import { OrthographicCamera, PerspectiveCamera } from "three";
import { FRUSTUM } from "./constants.ts";
import type { CameraPose } from "./messages.ts";

// The render worker owns the cameras (lifted out of the scene factories so the store-owned pose
// drives them and shader HMR can rebuild a scene without losing the view). This is the one place
// THREE camera math lives. Pose shape + lens constants are shared via @schema/camera.ts.

export { DEFAULT_POSE };

// Perspective camera for the volume raymarcher. near matches the legacy raymarchScene camera;
// far is an init placeholder — applyPose owns it (sized per pose so the dolly range never far-clips).
export function createPerspectiveCamera(aspect = 1): PerspectiveCamera {
  return new PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.01, 10);
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

// Orbit-spherical placement shared by both volume cameras. z-up (world=physical): azimuth sweeps
// the xy-plane (0 → +x, increasing toward +y, CCW about +z), elevation lifts toward +z.
function placeCamera(camera: PerspectiveCamera | OrthographicCamera, pose: CameraPose): void {
  const [tx, ty, tz] = pose.target;
  const ce = Math.cos(pose.elevation);
  camera.position.set(
    tx + pose.distance * ce * Math.cos(pose.azimuth),
    ty + pose.distance * ce * Math.sin(pose.azimuth),
    tz + pose.distance * Math.sin(pose.elevation),
  );
  camera.up.set(0, 0, 1);
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
  const camera = new OrthographicCamera(-aspect, aspect, 1, -1, 0.01, 10);
  applyPoseOrtho(camera, DEFAULT_POSE, aspect);
  return camera;
}

// Matched frustum: halfH = distance·tan(fov/2) shows the perspective view's extent at the target
// plane, so flipping projection keeps the on-screen scale (only parallax changes) and `distance`
// stays the single zoom parameter (the frustum follows it).
export function applyPoseOrtho(camera: OrthographicCamera, pose: CameraPose, aspect = 1): void {
  placeCamera(camera, pose);
  const halfH = pose.distance * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
  camera.left = -halfH * aspect;
  camera.right = halfH * aspect;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.far = poseFar(pose);
  camera.updateProjectionMatrix(); // the frustum follows distance — no change guard pays off
}
