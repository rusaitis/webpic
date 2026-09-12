import type { GridInfo } from "@containers/field_dataset.ts";
import { axisPhysicalSpan } from "@containers/grid.ts";
import type { SliceAxis } from "@schema/layers.ts";
import { clamp, UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import { intersectCenteredBox } from "@schema/rayBox.ts";
import type { Vec3 } from "@schema/types.ts";

// Raycast seed picking for field-line tracing: turn a cursor ray into a seed in the grid's *physical*
// (code-unit) coordinates — the space numerics/tracing and the WGSL kernel integrate in. Per axis,
// world [-h, h] ↔ texture [0, 1] ↔ physical [origin, origin + dim·dx] (DESIGN §Coordinate systems).
// The interpolator applies its OWN −0.5 cell-centered offset, so a seed must be PHYSICAL, not index,
// and must land inside [origin + 0.5dx, origin + (dim − 0.5)dx] or the trace exits on its first step.
// That offset is the load-bearing picking ↔ tracing invariant: wrong, and traces diverge from pypic.

// A slice's held axis ("x" holds world/field axis 0, …) → its index. SliceAxis is store/layers' (the
// in-layer single source); the hold mapping matches render/sliceScene.
const AXIS_INDEX: Record<SliceAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

// Which box-chord point a volume pick seeds at: "entry" = where the ray first crosses into the box
// (the near face — predictable for "click over the volume, seed on the surface"); "midpoint" = chord
// center. Opacity-weighted depth (land on the dominant structure) is the app's render/pickRay path.
export type VolumeDepth = "entry" | "midpoint";

const EPS = 1e-9;

// World point (unit box) → physical grid coordinate. Pure bijection with `gridToWorld`; does NOT
// clamp to the traceable domain (see `clampSeedToDomain`).
export function worldToGrid(
  world: Vec3,
  grid: GridInfo,
  halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT,
): Vec3 {
  const map = (i: 0 | 1 | 2): number => {
    const h = halfExtent[i] || 0.5; // unit-box half-size on this axis (guard a degenerate 0)
    const t01 = (world[i] + h) / (2 * h); // [-h, h] → [0, 1]
    return (grid.origin[i] ?? 0) + t01 * axisPhysicalSpan(grid, i); // [0, 1] → [origin, origin + dim·dx]
  };
  return [map(0), map(1), map(2)];
}

// Physical grid coordinate → world point (unit box). Inverse of `worldToGrid` — places the picker
// marker (the store's pickerPoint is world space) at a grid seed; the round-trip tests pin both.
export function gridToWorld(
  physical: Vec3,
  grid: GridInfo,
  halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT,
): Vec3 {
  const map = (i: 0 | 1 | 2): number => {
    const span = axisPhysicalSpan(grid, i) || 1;
    const t01 = (physical[i] - (grid.origin[i] ?? 0)) / span; // [origin, origin + span] → [0, 1]
    const h = halfExtent[i] || 0.5;
    return t01 * (2 * h) - h; // [0, 1] → [-h, h]
  };
  return [map(0), map(1), map(2)];
}

// Pull a physical coordinate into the interpolator's traceable cell-center domain
// [origin + 0.5dx, origin + (dim − 0.5)dx] per axis (numerics/interp's in-domain range), so a seed on
// a box face / slice edge still traces instead of exiting on step 0. A degenerate axis (dim ≤ 1) pins
// to its lone cell center.
export function clampSeedToDomain(physical: Vec3, grid: GridInfo): Vec3 {
  const map = (i: 0 | 1 | 2): number => {
    const origin = grid.origin[i] ?? 0;
    const dim = grid.dimensions[i] ?? 1;
    const dx = grid.spacing[i];
    const step = dx !== undefined && Number.isFinite(dx) && dx > 0 ? dx : 1;
    const lo = origin + 0.5 * step;
    const hi = origin + (dim - 0.5) * step;
    return lo <= hi ? clamp(physical[i], lo, hi) : (lo + hi) / 2;
  };
  return [map(0), map(1), map(2)];
}

// Whether a physical coordinate already lies in the traceable cell-center domain — the predicate
// behind `clampSeedToDomain`. Seeds retained across a dataset switch are in the *old* grid's
// coordinates, so this is what tells a stale rake from a placed one.
export function isSeedInDomain(physical: Vec3, grid: GridInfo): boolean {
  const clamped = clampSeedToDomain(physical, grid);
  return clamped[0] === physical[0] && clamped[1] === physical[1] && clamped[2] === physical[2];
}

// A starter line of `count` seeds across the domain center along the grid's longest axis, each pulled
// into the traceable cell-center domain (`clampSeedToDomain`). Physical coords — the tracer adds its
// own −0.5 offset. The starter rake for layers with no user-placed seeds; a few seeds that reliably
// cross the structure of a centered configuration (flux rope / dipole).
export function defaultSeedRake(grid: GridInfo, count = 8): Vec3[] {
  const n = Math.max(2, count);
  let axis = 0; // the longest physical axis carries the rake; the other two sit at domain center
  for (let i = 1; i < 3; i++)
    if (axisPhysicalSpan(grid, i) > axisPhysicalSpan(grid, axis)) axis = i;
  const lo = grid.origin[axis] ?? 0;
  const span = axisPhysicalSpan(grid, axis);
  const center = (i: number): number => (grid.origin[i] ?? 0) + 0.5 * axisPhysicalSpan(grid, i);
  const seeds: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const along = lo + ((k + 0.5) / n) * span; // evenly spaced, inset from the faces
    const raw: Vec3 = [
      axis === 0 ? along : center(0),
      axis === 1 ? along : center(1),
      axis === 2 ? along : center(2),
    ];
    seeds.push(clampSeedToDomain(raw, grid));
  }
  return seeds;
}

// Ray ∩ volume box → seed (grid coords, clamped to the traceable domain), or null on a miss. `depth`
// picks the box-chord point; "entry" is the predictable default. The pure geometric pick "against the
// volume bounds" — opacity-weighted depth (the dominant structure) stays the app's render/pickRay
// path, which feeds its world hit back through `worldToGrid` + `clampSeedToDomain`.
export function seedFromVolume(
  origin: Vec3,
  dir: Vec3,
  grid: GridInfo,
  halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT,
  depth: VolumeDepth = "entry",
): Vec3 | null {
  const hit = intersectCenteredBox(origin, dir, halfExtent);
  if (hit === null) return null;
  const tEntry = Math.max(hit.tNear, 0); // camera inside the box → start at the camera
  if (hit.tFar < tEntry) return null; // box entirely behind the camera
  const t = depth === "entry" ? tEntry : (tEntry + hit.tFar) / 2;
  const world: Vec3 = [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
  return clampSeedToDomain(worldToGrid(world, grid, halfExtent), grid);
}

// Ray ∩ the slice's axis-aligned plane (held world axis at `position01` ∈ [0, 1] across the box) →
// seed (grid coords, clamped to the traceable domain). null when the ray is parallel to the plane,
// the plane sits behind the camera, or the hit falls outside the box face (clicked off the slice
// quad). Matches render/sliceScene's axis→world-axis hold + position→texture mapping.
export function seedFromSlice(
  origin: Vec3,
  dir: Vec3,
  axis: SliceAxis,
  position01: number,
  grid: GridInfo,
  halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT,
): Vec3 | null {
  const ai = AXIS_INDEX[axis];
  const h = halfExtent[ai] || 0.5;
  const planeWorld = clamp(position01, 0, 1) * (2 * h) - h; // [0, 1] → [-h, h] along the held axis
  const d = dir[ai];
  if (Math.abs(d) < EPS) return null; // ray parallel to the plane — no intersection
  const t = (planeWorld - origin[ai]) / d;
  if (t < 0) return null; // plane behind the camera
  const world: Vec3 = [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
  // A slice is bounded by the box face: off it on either free axis → miss.
  for (let i = 0; i < 3; i++) {
    if (i === ai) continue;
    const hi = halfExtent[i] ?? 0.5;
    const wi = world[i] ?? 0;
    if (wi < -hi - EPS || wi > hi + EPS) return null;
  }
  return clampSeedToDomain(worldToGrid(world, grid, halfExtent), grid);
}
