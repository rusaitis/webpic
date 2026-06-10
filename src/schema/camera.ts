import type { Vec3 } from "./types.ts";

// The orbit camera pose shared across the ui→store→render boundary (schema is the DAG root all
// three may import). One definition replaces the store/render twins that drifted only by comment.

export interface CameraPose {
  readonly target: Vec3; // look-at point, scene/code units
  readonly azimuth: number; // radians; 0 looks from +x toward the target, increasing toward +y (CCW about +z)
  readonly elevation: number; // radians from the xy-plane toward +z
  readonly distance: number; // > 0, camera → target
}

// Volume-view projection (slices are always screen-aligned ortho). Shared here for the same
// reason as CameraPose: one definition instead of store/render twins synced by comment.
export type CameraProjection = "perspective" | "orthographic";

// Vertical field of view. The store's zoom-to-cursor/pan ray math and the render-side perspective
// camera must agree on this, or the world point under the cursor drifts during a dolly.
export const CAMERA_FOV_DEG = 45;

// z-up 3/4 view — position ≈ (1.50, 1.50, 1.10) looking at the origin, +z up.
export const DEFAULT_POSE: CameraPose = {
  target: [0, 0, 0],
  azimuth: Math.PI / 4,
  elevation: 0.4773,
  distance: 2.3937,
};
