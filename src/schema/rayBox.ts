import type { Vec3 } from "@schema/types.ts";

// Analytic ray vs axis-aligned box (slab method) — the CPU twin of the WGSL `hitBox` in
// raymarchScene.ts. The shader uses the branch-free `1/dir` form (valid when no direction
// component is exactly zero, as camera rays are); this reference also covers axis-parallel
// rays so it can back CPU seed-picking later. `tNear` is negative when the origin is inside.

export interface RayBoxHit {
  readonly tNear: number;
  readonly tFar: number;
}

// One slab's [tEnter, tExit] along the ray, or null when a ray parallel to the slab misses.
function axisSlab(o: number, d: number, lo: number, hi: number): readonly [number, number] | null {
  if (d === 0) {
    return o < lo || o > hi ? null : [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  const a = (lo - o) / d;
  const b = (hi - o) / d;
  return a <= b ? [a, b] : [b, a];
}

/** Intersect the ray `origin + t·dir` with the box `[boxMin, boxMax]`. Returns entry/exit
 *  parameters, or null when the ray misses or the box lies entirely behind the origin. */
export function intersectRayBox(
  origin: Vec3,
  dir: Vec3,
  boxMin: Vec3,
  boxMax: Vec3,
): RayBoxHit | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  const [lx, ly, lz] = boxMin;
  const [hx, hy, hz] = boxMax;

  const sx = axisSlab(ox, dx, lx, hx);
  const sy = axisSlab(oy, dy, ly, hy);
  const sz = axisSlab(oz, dz, lz, hz);
  if (sx === null || sy === null || sz === null) return null;

  const tNear = Math.max(sx[0], sy[0], sz[0]);
  const tFar = Math.min(sx[1], sy[1], sz[1]);
  return tNear <= tFar && tFar >= 0 ? { tNear, tFar } : null;
}
