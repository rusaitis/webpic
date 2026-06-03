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
