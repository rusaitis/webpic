import type { Vec3 } from "@schema/types.ts";

// TS twin of raymarchScene's WGSL `brickAdvance` (the rayBox.ts ↔ hitBox precedent): the empty-space
// skip step. Given a point in texture space [0,1]³ inside the skip grid, returns the ray-t distance
// to the far face of its current brick — a one-brick slab test. `grid` is the per-axis brick count.
// The march jumps this far across a transparent brick. An axis (near-)parallel to its faces can't
// bound the brick, so it returns +∞ and the crossing falls to another axis; the result is therefore
// the distance to the *nearest* exit face and is always ≥ 0 (the face lies ahead in the travel dir).

const NEAR_ZERO = 1e-8;

function faceDistance(p: number, d: number, g: number): number {
  if (Math.abs(d) <= NEAR_ZERO) return Number.POSITIVE_INFINITY;
  const cell = Math.floor(p * g);
  const face = (cell + (d > 0 ? 1 : 0)) / g; // the brick face in the travel direction
  return (face - p) / d; // ≥ 0: numerator and denominator share sign
}

/** Ray-t distance from `texPos` to its current brick's far face under `grid` brick counts. */
export function brickAdvanceDistance(texPos: Vec3, dir: Vec3, grid: Vec3): number {
  return Math.min(
    faceDistance(texPos[0], dir[0], grid[0]),
    faceDistance(texPos[1], dir[1], grid[1]),
    faceDistance(texPos[2], dir[2], grid[2]),
  );
}
