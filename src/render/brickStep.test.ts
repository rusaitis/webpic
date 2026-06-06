import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { brickAdvanceDistance } from "./brickStep.ts";

// brickAdvanceDistance is the empty-space-skip step; getting it wrong either stalls the march (skip
// of ~0 → no progress) or overshoots occupied bricks (visible holes). These pin the slab geometry.

const norm = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
};

describe("brickAdvanceDistance", () => {
  it("steps to the far face along +x", () => {
    // grid 4 → brick width 0.25. From x=0.1 in brick 0, the +x face is at 0.25.
    expect(brickAdvanceDistance([0.1, 0.5, 0.5], [1, 0, 0], [4, 4, 4])).toBeCloseTo(0.15, 12);
  });

  it("steps to the near face along −x (distance, not signed)", () => {
    // Travelling −x from x=0.1 in brick 0, the exit face is the lower one at 0.0.
    expect(brickAdvanceDistance([0.1, 0.5, 0.5], [-1, 0, 0], [4, 4, 4])).toBeCloseTo(0.1, 12);
  });

  it("takes the nearest face on a diagonal ray", () => {
    // grid 2 → faces at 0.5. dir is equal on all axes, so the axis with the smallest gap to its face
    // bounds the brick: y (gap 0.3) beats x (0.4) and z (0.45).
    const dir = norm([1, 1, 1]);
    const t = brickAdvanceDistance([0.1, 0.2, 0.05], dir, [2, 2, 2]);
    expect(t).toBeCloseTo(0.3 / dir[1], 12); // y reaches 0.5 first: (0.5 − 0.2)/dir.y
  });

  it("lands exactly on a brick face (the crossing axis hits an integer cell boundary)", () => {
    const grid: Vec3 = [5, 3, 7];
    const texPos: Vec3 = [0.137, 0.611, 0.42];
    const dir = norm([0.4, -0.8, 0.45]);
    const t = brickAdvanceDistance(texPos, dir, grid);
    const hit: Vec3 = [texPos[0] + t * dir[0], texPos[1] + t * dir[1], texPos[2] + t * dir[2]];
    // The crossing coordinate × its grid count is an integer — a brick boundary.
    const cells: Vec3 = [hit[0] * grid[0], hit[1] * grid[1], hit[2] * grid[2]];
    const onFace = cells.some((c) => Math.abs(c - Math.round(c)) < 1e-9);
    expect(onFace).toBe(true);
    expect(t).toBeGreaterThan(0);
  });

  it("ignores an axis parallel to its faces (no spurious near-zero step)", () => {
    // dir.x ≈ 0: the x faces are unreachable, so the y face bounds the brick — not a 0-length step.
    const t = brickAdvanceDistance([0.999, 0.1, 0.5], [0, 1, 0], [10, 4, 4]);
    expect(t).toBeCloseTo(0.15, 12); // y: (0.25 − 0.1)/1, x contributes +∞
    expect(Number.isFinite(t)).toBe(true);
  });

  it("leaves the current brick after advancing (with a small nudge)", () => {
    const grid: Vec3 = [8, 8, 8];
    const texPos: Vec3 = [0.31, 0.66, 0.12];
    const dir = norm([0.5, 0.3, -0.7]);
    const t = brickAdvanceDistance(texPos, dir, grid) + 1e-4; // raymarch adds BRICK_EPS
    const cell = (p: Vec3): Vec3 => [
      Math.floor(p[0] * grid[0]),
      Math.floor(p[1] * grid[1]),
      Math.floor(p[2] * grid[2]),
    ];
    const before = cell(texPos);
    const after = cell([texPos[0] + t * dir[0], texPos[1] + t * dir[1], texPos[2] + t * dir[2]]);
    expect(after).not.toEqual(before); // we crossed into a different brick
  });
});
