import type { OrthographicCamera, PerspectiveCamera } from "three";
import type { CameraPose } from "../messages.ts";
import {
  applyPose,
  applyPoseOrtho,
  createOrthographicCamera,
  createPerspectiveCamera,
  createVolumeOrthographicCamera,
} from "./camera.ts";

// The worker's three cameras as one unit: the pose-driven volume pair (perspective + the
// matched-frustum ortho the projection toggle swaps in) and the static screen-aligned ortho for
// slices + the boot triangle. Pure JS matrices — they hold no GPU resources, so they survive a device
// loss untouched (only scenes/textures rebuild). `apply` re-aims BOTH volume cameras so a projection
// flip never shows a stale frustum; the screen-aligned ortho is pose-invariant.
export interface CameraRig {
  // The active volume camera for the projection (perspective, or the matched-frustum ortho).
  volumeCamera(isOrthographic: boolean): PerspectiveCamera | OrthographicCamera;
  // The screen-aligned ortho camera (slices + boot triangle); pose-invariant.
  readonly orthoCamera: OrthographicCamera;
  // Re-aim both volume cameras at the pose + aspect (a pose change or a resize).
  apply(pose: CameraPose, aspect: number): void;
}

export function createCameraRig(aspect: number): CameraRig {
  const perspectiveCamera = createPerspectiveCamera(aspect);
  const orthoVolumeCamera = createVolumeOrthographicCamera(aspect);
  const orthoCamera = createOrthographicCamera();
  return {
    volumeCamera: (isOrthographic) => (isOrthographic ? orthoVolumeCamera : perspectiveCamera),
    orthoCamera,
    apply(pose, aspect) {
      applyPose(perspectiveCamera, pose, aspect);
      applyPoseOrtho(orthoVolumeCamera, pose, aspect);
    },
  };
}
