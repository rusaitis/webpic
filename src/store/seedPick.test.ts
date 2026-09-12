import type { GridInfo } from "@containers/field_dataset.ts";
import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { makeGrid } from "../../tests/fixtures.ts";
import {
  clampSeedToDomain,
  defaultSeedRake,
  gridToWorld,
  isSeedInDomain,
  seedFromSlice,
  seedFromVolume,
  worldToGrid,
} from "./seedPick.ts";

const UNIT: Vec3 = [0.5, 0.5, 0.5];
// dim 4 / dx 1 / origin 0 → physical box [0, 4]³, cell centers {0.5, 1.5, 2.5, 3.5}, domain [0.5, 3.5].
const CUBIC = makeGrid([4, 4, 4], [1, 1, 1], [0, 0, 0]);
// dim 4 / dx 2 / origin (10,20,30) → physical box x[10,18] y[20,28] z[30,38]; spans 8 → cubic unit box.
const SHIFTED = makeGrid([4, 4, 4], [2, 2, 2], [10, 20, 30]);
// Long x axis → anisotropic box: spans 4,2,2, max 4 → halfExtent [0.5, 0.25, 0.25].
const ANISO = makeGrid([4, 2, 2], [1, 1, 1], [0, 0, 0]);
const ANISO_HALF: Vec3 = [0.5, 0.25, 0.25];

function expectVec(actual: Vec3 | null, expected: Vec3, precision = 12): void {
  expect(actual).not.toBeNull();
  if (actual === null) return;
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i] ?? Number.NaN, precision);
}

describe("worldToGrid / gridToWorld", () => {
  it("maps the box center to the physical box center and the corners to the data box", () => {
    expectVec(worldToGrid([0, 0, 0], CUBIC), [2, 2, 2]); // unit-box center → mid of [0,4]³
    expectVec(worldToGrid([-0.5, -0.5, -0.5], CUBIC), [0, 0, 0]); // lower corner → origin
    expectVec(worldToGrid([0.5, 0.5, 0.5], CUBIC), [4, 4, 4]); // upper corner → origin + dim·dx
    expectVec(worldToGrid([0, 0, 0], SHIFTED), [14, 24, 34]); // honors origin + spacing
  });

  it("lands a texture cell-center world point exactly on that cell (the tracer's −0.5 invariant)", () => {
    // World at texture (i+0.5)/dim for i = 1, dim = 4 → t01 = 0.375 → world = 0.375·1 − 0.5.
    const world: Vec3 = [0.375 - 0.5, 0.375 - 0.5, 0.375 - 0.5];
    const p = worldToGrid(world, CUBIC);
    expectVec(p, [1.5, 1.5, 1.5]); // physical cell center origin + (i+0.5)·dx
    // interp's physical→index map (numerics/interp), restated: (p − origin)/dx − 0.5 == i exactly.
    for (let i = 0; i < 3; i++) expect(((p[i] ?? 0) - 0) / 1 - 0.5).toBeCloseTo(1, 12);
  });

  it("round-trips world → grid → world across cubic, shifted, and anisotropic grids", () => {
    const cases: ReadonlyArray<{ grid: GridInfo; half: Vec3; pts: readonly Vec3[] }> = [
      {
        grid: CUBIC,
        half: UNIT,
        pts: [
          [0, 0, 0],
          [0.1, -0.2, 0.3],
          [-0.5, 0.5, -0.5],
        ],
      },
      {
        grid: SHIFTED,
        half: UNIT,
        pts: [
          [0.4, -0.4, 0.25],
          [-0.5, -0.5, -0.5],
        ],
      },
      {
        grid: ANISO,
        half: ANISO_HALF,
        pts: [
          [0.3, -0.2, 0.1],
          [-0.5, 0.25, -0.25],
        ],
      },
    ];
    for (const { grid, half, pts } of cases) {
      for (const w of pts) expectVec(gridToWorld(worldToGrid(w, grid, half), grid, half), w);
    }
  });
});

describe("clampSeedToDomain", () => {
  it("pulls a face/edge coordinate into the cell-center domain, leaves interior alone", () => {
    expectVec(clampSeedToDomain([0, 0, 0], CUBIC), [0.5, 0.5, 0.5]); // lower face → first cell center
    expectVec(clampSeedToDomain([4, 4, 4], CUBIC), [3.5, 3.5, 3.5]); // upper face → last cell center
    expectVec(clampSeedToDomain([2, 2, 2], CUBIC), [2, 2, 2]); // interior unchanged
    expectVec(clampSeedToDomain([10, 20, 30], SHIFTED), [11, 21, 31]); // origin + 0.5·dx per axis
  });

  it("pins a degenerate (dim 1) axis to its lone cell center", () => {
    const flat = makeGrid([1, 4, 4], [1, 1, 1], [0, 0, 0]); // x has one sample → domain lo == hi
    expect(clampSeedToDomain([99, 2, 2], flat)[0]).toBeCloseTo(0.5, 12);
  });
});

describe("isSeedInDomain", () => {
  it("accepts the cell-center domain and rejects everything past it", () => {
    expect(isSeedInDomain([2, 2, 2], CUBIC)).toBe(true);
    expect(isSeedInDomain([0.5, 0.5, 0.5], CUBIC)).toBe(true); // the bound itself is traceable
    expect(isSeedInDomain([3.5, 3.5, 3.5], CUBIC)).toBe(true);
    expect(isSeedInDomain([0, 2, 2], CUBIC)).toBe(false); // the box face is outside it
    expect(isSeedInDomain([2, 2, 2], SHIFTED)).toBe(false); // another grid's coordinates
  });
});

describe("seedFromVolume", () => {
  it("seeds the near face on entry and the box center at the chord midpoint", () => {
    // Straight-on from +x: ray enters at world x = +0.5 (physical 4, clamped to the last cell center).
    expectVec(seedFromVolume([2, 0, 0], [-1, 0, 0], CUBIC, UNIT, "entry"), [3.5, 2, 2]);
    expectVec(seedFromVolume([2, 0, 0], [-1, 0, 0], CUBIC, UNIT, "midpoint"), [2, 2, 2]);
  });

  it("misses a parallel ray outside the box and a box that lies behind the camera", () => {
    expect(seedFromVolume([2, 1, 0], [-1, 0, 0], CUBIC, UNIT)).toBeNull(); // parallel, off the y slab
    expect(seedFromVolume([2, 0, 0], [1, 0, 0], CUBIC, UNIT)).toBeNull(); // box entirely behind
  });

  it("clips against an anisotropic box", () => {
    // Along the short y axis (±0.25): enters at y = +0.25 → physical y = 2 (clamped to 1.5), x/z center.
    expectVec(seedFromVolume([0, 2, 0], [0, -1, 0], ANISO, ANISO_HALF, "entry"), [2, 1.5, 1]);
    expect(seedFromVolume([0, 0.4, 0], [-1, 0, 0], ANISO, ANISO_HALF)).toBeNull(); // clears the short face
  });
});

describe("seedFromSlice", () => {
  it("intersects the held-axis plane and maps the hit to grid coordinates", () => {
    // z-slice at position 0.5 → world z = 0; a ray down −z through the center lands on the box center.
    expectVec(seedFromSlice([0, 0, 2], [0, 0, -1], "z", 0.5, CUBIC, UNIT), [2, 2, 2]);
    // x-slice at 0.5 → world x = 0; straight-on −x ray → same center.
    expectVec(seedFromSlice([2, 0, 0], [-1, 0, 0], "x", 0.5, CUBIC, UNIT), [2, 2, 2]);
  });

  it("clamps a slice on the box face to the first cell center (so the seed still traces)", () => {
    // position 0 → world z = −0.5 (box face) → physical z = 0, clamped up to 0.5.
    expectVec(seedFromSlice([0, 0, 2], [0, 0, -1], "z", 0, CUBIC, UNIT), [2, 2, 0.5]);
  });

  it("misses a ray parallel to the plane and a hit off the slice quad", () => {
    expect(seedFromSlice([0, 0, 2], [1, 0, 0], "z", 0.5, CUBIC, UNIT)).toBeNull(); // parallel to z-plane
    expect(seedFromSlice([0, 0, 2], [1, 0, -1], "z", 0.5, CUBIC, UNIT)).toBeNull(); // hits z=0 at x=2 (off)
  });

  it("honors origin/spacing and an anisotropic box", () => {
    // The ray is world (unit-box) space; the seed comes back in physical grid coords.
    expectVec(seedFromSlice([0, 0, 2], [0, 0, -1], "z", 0.5, SHIFTED, UNIT), [14, 24, 34]);
    expectVec(seedFromSlice([0, 0, 1], [0, 0, -1], "z", 0.5, ANISO, ANISO_HALF), [2, 1, 1]);
  });
});

describe("defaultSeedRake", () => {
  // Every coord must land in the interpolator's traceable cell-center domain, or the trace exits at
  // step 0. The domain per axis is [origin + 0.5dx, origin + (dim − 0.5)dx].
  const inDomain = (seeds: readonly Vec3[], grid: GridInfo): void => {
    for (const seed of seeds) {
      for (let i = 0; i < 3; i++) {
        const origin = grid.origin[i] ?? 0;
        const dx = grid.spacing[i] ?? 1;
        const dim = grid.dimensions[i] ?? 1;
        expect(seed[i]).toBeGreaterThanOrEqual(origin + 0.5 * dx - 1e-9);
        expect(seed[i]).toBeLessThanOrEqual(origin + (dim - 0.5) * dx + 1e-9);
      }
    }
  };

  it("returns `count` seeds, all inside the traceable domain", () => {
    expect(defaultSeedRake(CUBIC)).toHaveLength(8); // default count
    expect(defaultSeedRake(CUBIC, 5)).toHaveLength(5);
    inDomain(defaultSeedRake(CUBIC, 12), CUBIC);
    inDomain(defaultSeedRake(SHIFTED, 6), SHIFTED); // non-zero origin + spacing
  });

  it("rakes along the longest axis with the others pinned to domain center", () => {
    // ANISO spans 4,2,2 → x is longest; y,z sit at physical center 1.0 (clamped into [0.5,1.5]).
    const seeds = defaultSeedRake(ANISO, 4);
    inDomain(seeds, ANISO);
    for (const seed of seeds) {
      expect(seed[1]).toBeCloseTo(1, 12);
      expect(seed[2]).toBeCloseTo(1, 12);
    }
    const xs = seeds.map((s) => s[0]);
    expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs)); // spread along x
  });
});
