import { CAMERA_HALF_FOV_TAN, type CameraPose } from "@schema/camera.ts";
import {
  type HandleAxis,
  horizontalDragAllowed,
  horizontalDragAxis,
  MARKER_SPHERE_RADIUS,
  markerCoreScale,
  markerHandleOffset,
  verticalDragAllowed,
} from "@schema/marker.ts";
import { clamp, UNIT_BOX_HALF_EXTENT, vec3 } from "@schema/math.ts";
import type { Vec3 } from "@schema/types.ts";
import type { CursorRay } from "./pick.ts";

// Main-thread point-picker math: project the marker / its handles to screen for hit-testing, and
// solve the cursor ray against a drag plane or axis. Pure (no DOM, no THREE) — ui/pointerPicker owns
// the pointer state machine and feeds these. Shares the unit-box object space and the exact orbit
// basis with store/pick.cursorRay, so a projected point round-trips with its ray (tested).

export interface ScreenPoint {
  readonly ndcX: number;
  readonly ndcY: number;
  readonly behind: boolean; // the point is on/behind the camera plane — ndc is meaningless
}

// Project a world point to NDC (x right, y up) — the inverse of cursorRay, reusing its orthonormal
// orbit basis (forward, screenRight = (−sa, ca, 0), screenUp = (−ca·se, −sa·se, ce)). Perspective
// divides by the forward depth; orthographic by the constant orbit distance (parallel rays).
// A point this close to the eye plane has no meaningful screen position — the perspective divide
// would explode. Report it as behind rather than projecting a wild NDC.
const EYE_PLANE_EPSILON = 1e-9;

// Ray ∥ plane / ray ∥ axis: the solve degenerates, so the caller keeps the marker where it is.
// Looser for the plane case, where a grazing hit is already numerically useless well before it is
// exactly parallel.
const PARALLEL_PLANE_EPSILON = 1e-6;
const PARALLEL_AXIS_EPSILON = 1e-9;

export function worldToScreen(
  pose: CameraPose,
  point: Vec3,
  aspect: number,
  isOrthographic: boolean,
): ScreenPoint {
  const ce = Math.cos(pose.elevation);
  const se = Math.sin(pose.elevation);
  const sa = Math.sin(pose.azimuth);
  const ca = Math.cos(pose.azimuth);
  const [tx, ty, tz] = pose.target;
  const d = pose.distance;
  const camX = tx + d * ce * ca;
  const camY = ty + d * ce * sa;
  const camZ = tz + d * se;
  const vx = point[0] - camX;
  const vy = point[1] - camY;
  const vz = point[2] - camZ;
  const zc = vx * -ce * ca + vy * -ce * sa + vz * -se; // along forward
  const xr = vx * -sa + vy * ca; // along screenRight
  const yu = vx * -ca * se + vy * -sa * se + vz * ce; // along screenUp
  const denom = isOrthographic ? d : zc;
  if (denom <= EYE_PLANE_EPSILON) return { ndcX: 0, ndcY: 0, behind: true };
  return {
    ndcX: xr / (denom * CAMERA_HALF_FOV_TAN * aspect),
    ndcY: yu / (denom * CAMERA_HALF_FOV_TAN),
    behind: zc <= 0,
  };
}

// World positions of the ↕ (z) and ↔ (x|y) handle knobs at the current pose — null when that handle
// is gated off (vertical near top-down, horizontal outside the equatorial regime). The offset folds
// in the zoom scale the knob inherits as a child of the core. ui/pointerPicker projects these to
// hit-test the affordances; render/markerScene positions the real sprites identically.
export interface HandlePositions {
  readonly vertical: Vec3 | null;
  readonly horizontal: { readonly axis: HandleAxis; readonly position: Vec3 } | null;
}

export function markerHandlePositions(
  pose: CameraPose,
  point: Vec3,
  isOrthographic: boolean,
): HandlePositions {
  const offset = markerHandleOffset(pose, point, isOrthographic);
  const vertical: Vec3 | null = verticalDragAllowed(pose)
    ? vec3(point[0], point[1], point[2] + offset)
    : null;
  // The ↔ handle lives only in the near-equatorial regime — exactly where the free xy-plane drag is
  // unavailable — and only when one horizontal axis is cleanly cross-screen.
  const axis = horizontalDragAllowed(pose) ? null : horizontalDragAxis(pose);
  const horizontal =
    axis !== null
      ? {
          axis,
          position:
            axis === "x"
              ? vec3(point[0] + offset, point[1], point[2])
              : vec3(point[0], point[1] + offset, point[2]),
        }
      : null;
  return { vertical, horizontal };
}

// World point one zoom-scaled core radius to the screen-right of the marker. Projecting it beside
// the core measures the marker's on-screen radius, so the hover hit target can track the rendered
// size across dolly. screenRight matches worldToScreen's basis.
export function markerEdgePoint(pose: CameraPose, point: Vec3, isOrthographic: boolean): Vec3 {
  const radius = MARKER_SPHERE_RADIUS * markerCoreScale(pose, point, isOrthographic);
  return [
    point[0] - radius * Math.sin(pose.azimuth),
    point[1] + radius * Math.cos(pose.azimuth),
    point[2],
  ];
}

// Cursor-ray ∩ plane through `planePoint` with unit `planeNormal`. null when the ray is parallel to
// the plane (grazing view) — the caller keeps the marker put.
export function dragOnPlane(ray: CursorRay, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
  const { origin, dir } = ray;
  const denom = dir[0] * planeNormal[0] + dir[1] * planeNormal[1] + dir[2] * planeNormal[2];
  if (Math.abs(denom) < PARALLEL_PLANE_EPSILON) return null;
  const wx = planePoint[0] - origin[0];
  const wy = planePoint[1] - origin[1];
  const wz = planePoint[2] - origin[2];
  const t = (wx * planeNormal[0] + wy * planeNormal[1] + wz * planeNormal[2]) / denom;
  return [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
}

// Closest point on the world line {axisOrigin + s·axisDir} to the cursor ray — the 1-DOF axis drag
// (the ↕/↔ handles and Shift-vertical). `axisDir` must be unit. Parallel rays pin s = 0.
export function dragAlongAxis(ray: CursorRay, axisOrigin: Vec3, axisDir: Vec3): Vec3 {
  const { origin, dir } = ray;
  // L1 = axisOrigin + s·u, L2 = origin + t·v; closest s with a=u·u=1, c=v·v=1.
  const b = axisDir[0] * dir[0] + axisDir[1] * dir[1] + axisDir[2] * dir[2];
  const denom = 1 - b * b;
  let s = 0;
  if (Math.abs(denom) > PARALLEL_AXIS_EPSILON) {
    const rx = axisOrigin[0] - origin[0];
    const ry = axisOrigin[1] - origin[1];
    const rz = axisOrigin[2] - origin[2];
    const dU = axisDir[0] * rx + axisDir[1] * ry + axisDir[2] * rz;
    const eV = dir[0] * rx + dir[1] * ry + dir[2] * rz;
    s = (b * eV - dU) / denom;
  }
  return [
    axisOrigin[0] + s * axisDir[0],
    axisOrigin[1] + s * axisDir[1],
    axisOrigin[2] + s * axisDir[2],
  ];
}

// Keep a dragged point inside the render box. `halfExtent` is the per-axis world half-size — the unit
// box [-0.5, 0.5]³ for a cubic dataset, anisotropic for a non-cubic one (store `worldHalfExtent`).
export function clampToBox(point: Vec3, halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT): Vec3 {
  return [
    clamp(point[0], -halfExtent[0], halfExtent[0]),
    clamp(point[1], -halfExtent[1], halfExtent[1]),
    clamp(point[2], -halfExtent[2], halfExtent[2]),
  ];
}
