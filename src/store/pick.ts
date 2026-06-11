import { CAMERA_FOV_DEG, type CameraPose } from "@schema/camera.ts";
import type { Vec3 } from "@schema/types.ts";
import { DISTANCE_MAX, DISTANCE_MIN } from "./camera.ts";

// Pick-to-focus math: the cursor ray through a pose, its chord through the unit render box, and
// the focus pose that re-pivots the orbit there. Pure — ui/pointerCamera uses it as the synchronous
// double-click miss test, app/main as the fallback when the render worker can't refine the pick.

export interface CursorRay {
  readonly origin: Vec3;
  readonly dir: Vec3; // unit length
}

// The ray from the camera through an NDC point (x right, y up — dollyAt's convention). Same z-up
// orbit basis as dollyPoseToCursor/panPose: screenRight = (−sa, ca, 0), screenUp = (−ca·se, −sa·se, ce).
// Perspective rays fan out from the camera point; orthographic rays are parallel to forward, offset
// across the matched frustum (halfH = d·tan(fov/2) — render/camera.ts's applyPoseOrtho).
export function cursorRay(
  pose: CameraPose,
  ndcX: number,
  ndcY: number,
  aspect: number,
  orthographic: boolean,
): CursorRay {
  const ce = Math.cos(pose.elevation);
  const se = Math.sin(pose.elevation);
  const sa = Math.sin(pose.azimuth);
  const ca = Math.cos(pose.azimuth);
  const [tx, ty, tz] = pose.target;
  const d = pose.distance;
  const camera: Vec3 = [tx + d * ce * ca, ty + d * ce * sa, tz + d * se];
  const forward: Vec3 = [-ce * ca, -ce * sa, -se];
  const halfH = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
  const kr = halfH * ndcX * aspect; // along screenRight = (−sa, ca, 0)
  const ku = halfH * ndcY; // along screenUp = (−ca·se, −sa·se, ce)
  if (orthographic) {
    return {
      origin: [
        camera[0] + d * (-kr * sa - ku * ca * se),
        camera[1] + d * (kr * ca - ku * sa * se),
        camera[2] + d * ku * ce,
      ],
      dir: forward,
    };
  }
  const dx = forward[0] - kr * sa - ku * ca * se;
  const dy = forward[1] + kr * ca - ku * sa * se;
  const dz = forward[2] + ku * ce;
  const len = Math.hypot(dx, dy, dz);
  return { origin: camera, dir: [dx / len, dy / len, dz / len] };
}

// Slab test for one axis of the box [-half, half]; null = the ray misses this slab entirely.
function axisSlab(o: number, d: number, half: number): readonly [number, number] | null {
  if (d === 0) {
    return o < -half || o > half ? null : [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  const a = (-half - o) / d;
  const b = (half - o) / d;
  return a <= b ? [a, b] : [b, a];
}

// Midpoint of the ray's chord through the render box, or null on a miss. `halfExtent` is the per-axis
// world half-size — the unit box [-0.5, 0.5]³ for a cubic dataset, anisotropic for a non-cubic one
// (store `worldHalfExtent`). Restates render/rayBox.ts's slab test — the DAG forbids store → render,
// and ui (which needs the synchronous miss test) can only reach store.
const UNIT_HALF_EXTENT: Vec3 = [0.5, 0.5, 0.5];

export function unitBoxChordMidpoint(
  origin: Vec3,
  dir: Vec3,
  halfExtent: Vec3 = UNIT_HALF_EXTENT,
): Vec3 | null {
  const sx = axisSlab(origin[0], dir[0], halfExtent[0]);
  const sy = axisSlab(origin[1], dir[1], halfExtent[1]);
  const sz = axisSlab(origin[2], dir[2], halfExtent[2]);
  if (sx === null || sy === null || sz === null) return null;
  const tNear = Math.max(sx[0], sy[0], sz[0]);
  const tFar = Math.min(sx[1], sy[1], sz[1]);
  if (tNear > tFar || tFar < 0) return null;
  const t = (Math.max(tNear, 0) + tFar) / 2;
  return [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
}

// Focus dolly-in per pick: magviz's CAMERA_FOCUS_POINT glide pulls 30% closer alongside the pivot.
const FOCUS_DOLLY = 0.7;

// Re-pivot the orbit on a picked point: target flies there, the view direction holds, and the
// camera dollies 30% in (clamped). The existing flyTo tween animates the returned pose.
export function focusPoseOnPoint(pose: CameraPose, point: Vec3): CameraPose {
  return {
    target: point,
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    distance: Math.min(Math.max(pose.distance * FOCUS_DOLLY, DISTANCE_MIN), DISTANCE_MAX),
  };
}
