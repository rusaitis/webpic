import { OrthographicCamera, PerspectiveCamera } from "three";
import { FRUSTUM } from "./constants.ts";
import type { CameraPose } from "./messages.ts";

// The render worker owns the cameras (lifted out of the scene factories so the store-owned pose
// drives them and shader HMR can rebuild a scene without losing the view). This is the one place
// THREE camera math lives.

// Render-side default, applied at init before any pose streams in (the store's pose subscription
// fires only on change). Mirrors store/camera.ts DEFAULT_POSE — keep the two in sync.
// z-up 3/4 view: position ≈ (1.50, 1.50, 1.10) looking at the origin, +z up.
export const DEFAULT_POSE: CameraPose = {
  target: [0, 0, 0],
  azimuth: Math.PI / 4,
  elevation: 0.4773,
  distance: 2.3937,
};

// Perspective camera for the volume raymarcher. fov/near/far match the legacy raymarchScene camera.
// The 45° vertical fov restates store/camera.ts CAMERA_FOV_DEG (zoom-to-cursor ray math) — keep in sync.
export function createPerspectiveCamera(aspect = 1): PerspectiveCamera {
  return new PerspectiveCamera(45, aspect, 0.01, 10);
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

// Orbit-spherical → THREE perspective camera. z-up (world=physical): azimuth sweeps the xy-plane
// (0 → +x, increasing toward +y, CCW about +z), elevation lifts toward +z. The raymarch shader reads
// cameraPosition/modelWorldMatrixInverse, refreshed during render(), so a repaint right after this is
// sufficient.
export function applyPose(camera: PerspectiveCamera, pose: CameraPose, aspect = 1): void {
  const [tx, ty, tz] = pose.target;
  const ce = Math.cos(pose.elevation);
  camera.position.set(
    tx + pose.distance * ce * Math.cos(pose.azimuth),
    ty + pose.distance * ce * Math.sin(pose.azimuth),
    tz + pose.distance * Math.sin(pose.elevation),
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(tx, ty, tz);
  if (camera.aspect !== aspect) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
}
