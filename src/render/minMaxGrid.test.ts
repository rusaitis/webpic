import { describe, expect, it } from "vitest";
import { buildMinMaxGrid } from "./minMaxGrid.ts";
import type { ScalarField } from "./volumeTexture.ts";

// The grid is the empty-space-skip bound; its correctness is the whole optimization's safety. Bricks
// index the same (width, height, depth) = (shape[2], shape[1], shape[0]) layout the volume uploads,
// and each brick folds a 1-voxel halo so its max bounds any trilinear sample inside the brick.

const FALLBACK = -99; // a sentinel well below any real value so a fallback use is unmistakable

describe("buildMinMaxGrid", () => {
  it("brick counts are ceil(shape / brickSize) in (w, h, d) order", () => {
    const field: ScalarField = { data: new Float32Array(2 * 3 * 10), shape: [2, 3, 10] };
    // shape = [depth, height, width] = [2, 3, 10]; brickSize 4 → (ceil 10/4, 3/4, 2/4) = (3, 1, 1).
    const grid = buildMinMaxGrid(field, 4, 0);
    expect(grid.dims).toEqual([3, 1, 1]);
    expect(grid.max.length).toBe(3);
  });

  it("reduces a 1-D ramp with the 1-voxel halo folded in", () => {
    // 8 voxels along x (the fastest axis); value[x] = x. brickSize 4 → 2 bricks.
    const data = Float32Array.from({ length: 8 }, (_, x) => x);
    const grid = buildMinMaxGrid({ data, shape: [1, 1, 8] }, 4, 0);
    // brick 0 spans x∈[0,4) + halo → [0,5): values 0..4. brick 1 spans [4,8) + halo → [3,8): 3..7.
    expect([...grid.max]).toEqual([4, 7]);
    expect([...grid.min]).toEqual([0, 3]);
  });

  it("substitutes the fallback for non-finite voxels (matching the volume upload)", () => {
    const data = Float32Array.from([Number.NaN, 1, 2, Number.POSITIVE_INFINITY]);
    // One brick over all 4 voxels; NaN and +Inf fold to FALLBACK, so min = FALLBACK, max = 2.
    const grid = buildMinMaxGrid({ data, shape: [1, 1, 4] }, 4, FALLBACK);
    expect(grid.dims).toEqual([1, 1, 1]);
    expect(grid.min[0]).toBe(FALLBACK);
    expect(grid.max[0]).toBe(2);
  });

  it("handles a non-divisible extent with a partial trailing brick", () => {
    const data = Float32Array.from({ length: 10 }, (_, x) => x);
    const grid = buildMinMaxGrid({ data, shape: [1, 1, 10] }, 4, 0);
    // bricks span x: [0,5) → 0..4, [3,9) → 3..8, [7,11)→[7,10) → 7..9.
    expect(grid.dims).toEqual([3, 1, 1]);
    expect([...grid.max]).toEqual([4, 8, 9]);
    expect([...grid.min]).toEqual([0, 3, 7]);
  });

  it("collapses a constant field to min == max per brick", () => {
    const data = new Float32Array(4 * 4 * 4).fill(2.5);
    const grid = buildMinMaxGrid({ data, shape: [4, 4, 4] }, 2, 0);
    for (let i = 0; i < grid.max.length; i++) {
      expect(grid.min[i]).toBe(2.5);
      expect(grid.max[i]).toBe(2.5);
    }
  });

  it("indexes bricks x-fastest, matching the volume texture layout", () => {
    // 4×4×4, value = the C-order buffer index, so a brick's max pins down which voxels it covers.
    const [depth, height, width] = [4, 4, 4];
    const data = Float32Array.from({ length: width * height * depth }, (_, i) => i);
    const grid = buildMinMaxGrid({ data, shape: [depth, height, width] }, 2, 0);
    // brickSize 2 → 2×2×2 grid. The last brick (cx=cy=cz=1) covers the high corner incl. voxel 63
    // (x=y=z=3 → index 3 + 4*(3 + 4*3) = 63), the global max.
    const last = 1 + 2 * (1 + 2 * 1);
    expect(grid.max[last]).toBe(63);
    // The first brick (origin) cannot see the far corner; with the halo it reaches x,y,z ≤ 2.
    const firstMax = grid.max[0] ?? Number.NaN;
    expect(firstMax).toBeLessThan(63);
  });

  it("stored max conservatively bounds every voxel in the brick core (skip soundness)", () => {
    // Random-ish field; assert the brick max is ≥ every core voxel — the property the skip relies on.
    const [depth, height, width] = [9, 9, 9];
    const data = Float32Array.from(
      { length: width * height * depth },
      (_, i) => Math.sin(i * 0.7) * 3 + Math.cos(i * 0.13),
    );
    const brick = 3;
    const grid = buildMinMaxGrid({ data, shape: [depth, height, width] }, brick, 0);
    const gw = grid.dims[0];
    const gh = grid.dims[1];
    for (let z = 0; z < depth; z++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = data[x + width * (y + height * z)] ?? Number.NaN;
          const ci =
            Math.floor(x / brick) + gw * (Math.floor(y / brick) + gh * Math.floor(z / brick));
          expect(grid.max[ci] ?? Number.NaN).toBeGreaterThanOrEqual(v);
          expect(grid.min[ci] ?? Number.NaN).toBeLessThanOrEqual(v);
        }
      }
    }
  });

  it("rejects a non-3D field and a degenerate brick size", () => {
    expect(() => buildMinMaxGrid({ data: new Float32Array(4), shape: [4] }, 2, 0)).toThrow();
    expect(() => buildMinMaxGrid({ data: new Float32Array(8), shape: [2, 2, 2] }, 0, 0)).toThrow();
  });
});
