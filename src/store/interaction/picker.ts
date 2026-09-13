import { CAMERA_HALF_FOV_TAN, type CameraPose } from "@schema/camera.ts";
import { clamp, UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import { intersectCenteredBox } from "@schema/rayBox.ts";
import type { Vec3 } from "@schema/types.ts";
import {
  cameraPosition,
  DISTANCE_MAX,
  DISTANCE_MIN,
  ELEVATION_LIMIT,
  viewForward,
  viewPlaneOffset,
} from "./camera.ts";

// Pick-to-focus math: the cursor ray through a pose, its chord through the unit render box, and
// the focus pose that re-pivots the orbit there. Pure — ui/camera/pointerCamera uses it as the synchronous
// double-click miss test, app/main as the fallback when the render worker can't refine the pick.

export interface CursorRay {
  readonly origin: Vec3;
  readonly dir: Vec3; // unit length
}

// The ray from the camera through an NDC point (x right, y up — dollyAt's convention). View-plane
// displacement comes from viewPlaneOffset (store/interaction/camera.ts) — the shared z-up orbit basis.
// Perspective rays fan out from the camera point; orthographic rays are parallel to forward, offset
// across the matched frustum (halfH = d·tan(fov/2) — render/camera.ts's applyPoseOrtho).
export function cursorRay(
  pose: CameraPose,
  ndcX: number,
  ndcY: number,
  aspect: number,
  isOrthographic: boolean,
): CursorRay {
  const d = pose.distance;
  const camera = cameraPosition(pose);
  const forward = viewForward(pose);
  const o = viewPlaneOffset(pose, CAMERA_HALF_FOV_TAN * ndcX * aspect, CAMERA_HALF_FOV_TAN * ndcY);
  if (isOrthographic) {
    return {
      origin: [camera[0] + d * o[0], camera[1] + d * o[1], camera[2] + d * o[2]],
      dir: forward,
    };
  }
  const dx = forward[0] + o[0];
  const dy = forward[1] + o[1];
  const dz = forward[2] + o[2];
  const len = Math.hypot(dx, dy, dz);
  return { origin: camera, dir: [dx / len, dy / len, dz / len] };
}

// Midpoint of the ray's chord through the render box, or null on a miss. `halfExtent` is the per-axis
// world half-size — the unit box [-0.5, 0.5]³ for a cubic dataset, anisotropic for a non-cubic one
// (store `worldHalfExtent`). Shares the schema slab test with render/pickRay so ui's synchronous
// miss test and the worker's pick agree on the box.
export function unitBoxChordMidpoint(
  origin: Vec3,
  dir: Vec3,
  halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT,
): Vec3 | null {
  const hit = intersectCenteredBox(origin, dir, halfExtent);
  if (hit === null) return null;
  const t = (Math.max(hit.tNear, 0) + hit.tFar) / 2;
  return [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
}

// Focus dolly-in per pick: the glide pulls 30% closer alongside the pivot.
const FOCUS_DOLLY = 0.7;

// The goal distance a focus gesture commits to. Computed once at double-click time and carried
// through the pick round trip — recomputing it against the already-flying pose would compound ×0.7.
export function focusDistance(distance: number): number {
  return clamp(distance * FOCUS_DOLLY, DISTANCE_MIN, DISTANCE_MAX);
}

// The picked point sits on the camera itself (the camera is inside the box), so there is no aim
// direction to derive — keep the current angles rather than dividing by ~0.
const DEGENERATE_AIM_LENGTH = 1e-9;

// Re-pivot the orbit on a picked point: target flies there and the camera dollies in (clamped) —
// but instead of trucking sideways with the pivot (angles held), the goal angles re-aim the
// camera from where it stands toward the new pivot (it re-places the camera
// along the live target→camera ray each frame). An off-axis pick therefore swivels the view
// toward the point as it approaches; a centered pick reduces to a pure dolly. The existing
// flyTo tween animates the returned pose, shortest-arc on the swivel.
export function focusPoseOnPoint(
  pose: CameraPose,
  point: Vec3,
  distance: number = focusDistance(pose.distance),
): CameraPose {
  const [camX, camY, camZ] = cameraPosition(pose);
  const vx = camX - point[0];
  const vy = camY - point[1];
  const vz = camZ - point[2];
  const len = Math.hypot(vx, vy, vz);
  if (len < DEGENERATE_AIM_LENGTH) {
    return {
      target: point,
      azimuth: pose.azimuth,
      elevation: pose.elevation,
      distance,
      roll: pose.roll,
    };
  }
  const sinElevation = clamp(vz / len, -1, 1);
  return {
    target: point,
    azimuth: Math.atan2(vy, vx),
    elevation: clamp(Math.asin(sinElevation), -ELEVATION_LIMIT, ELEVATION_LIMIT),
    distance,
    roll: pose.roll,
  };
}
