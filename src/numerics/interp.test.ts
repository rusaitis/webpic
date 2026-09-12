import { describe, expect, it } from "vitest";
import { makeDataset, makeField, makeGrid } from "../../tests/fixtures.ts";
import { assertAllclose } from "../../tests/helpers.ts";
import { TOL } from "../../tests/tolerances.ts";
import { interpolatorFromDataset } from "./interp.ts";

// Trilinear sampling on CELL-CENTERED pypic grids: sample i sits at origin + (i + 0.5)·dx, so the
// in-domain interval is [origin + 0.5·dx, origin + (dim − 0.5)·dx] — narrower than the grid's
// physical box by half a cell on each side. A linear field is reproduced exactly (trilinear is
// exact on multilinear data), which is what makes an analytic check meaningful here.

const SHAPE: readonly number[] = [4, 3, 2];
const SPACING: readonly number[] = [2, 1, 0.5];
const ORIGIN: readonly number[] = [10, -5, 0];

type ScalarFn = (x: number, y: number, z: number) => number;

// Sample fn at the cell centers of the fixture grid, row-major (axis 2 fastest).
function cellCentered(fn: ScalarFn): Float64Array {
  const [nx = 0, ny = 0, nz = 0] = SHAPE;
  const out = new Float64Array(nx * ny * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const x = (ORIGIN[0] ?? 0) + (i + 0.5) * (SPACING[0] ?? 1);
        const y = (ORIGIN[1] ?? 0) + (j + 0.5) * (SPACING[1] ?? 1);
        const z = (ORIGIN[2] ?? 0) + (k + 0.5) * (SPACING[2] ?? 1);
        out[(i * ny + j) * nz + k] = fn(x, y, z);
      }
    }
  }
  return out;
}

// B = (x, y, z): linear per component, so a correct sampler returns the query point itself — any
// index/stride/offset error shows up as a displaced vector, not as a small numeric drift.
const IDENTITY_FIELD = makeDataset(
  {
    B_1: makeField(
      "B_1",
      cellCentered((x) => x),
      SHAPE,
    ),
    B_2: makeField(
      "B_2",
      cellCentered((_x, y) => y),
      SHAPE,
    ),
    B_3: makeField(
      "B_3",
      cellCentered((_x, _y, z) => z),
      SHAPE,
    ),
  },
  { grid: makeGrid(SHAPE, SPACING, ORIGIN) },
);

// The physical extent of the sampleable region: t = 0 and t = dim − 1 in index space.
const LOW: readonly number[] = [10 + 1, -5 + 0.5, 0 + 0.25];
const HIGH: readonly number[] = [10 + 7, -5 + 2.5, 0 + 0.75];

const sampleAt = (point: readonly number[]): { ok: boolean; out: Float64Array } => {
  const out = new Float64Array([Number.NaN, Number.NaN, Number.NaN]);
  const ok = interpolatorFromDataset(IDENTITY_FIELD).sample(Float64Array.from(point), out);
  return { ok, out };
};

describe("interpolatorFromDataset", () => {
  it("rejects a non-cartesian grid", () => {
    const grid = { ...IDENTITY_FIELD.grid, geometry: "spherical" } as const;
    const data = { ...IDENTITY_FIELD, grid };
    expect(() => interpolatorFromDataset(data)).toThrow(/needs a cartesian grid, got spherical/);
  });

  it("rejects a grid that is not 3-D", () => {
    const data = { ...IDENTITY_FIELD, grid: makeGrid([4, 3]) };
    expect(() => interpolatorFromDataset(data)).toThrow(/needs a 3-D grid, got 2-D/);
  });

  it("rejects a singleton axis, naming it", () => {
    const data = { ...IDENTITY_FIELD, grid: makeGrid([4, 3, 1]) };
    expect(() => interpolatorFromDataset(data)).toThrow(/axis 2 has 1 samples, needs ≥ 2/);
  });

  it("rejects a missing component, listing what the dataset has", () => {
    const data = {
      ...IDENTITY_FIELD,
      fields: new Map([["B_1", makeField("B_1", new Float64Array(24), SHAPE)]]),
    };
    expect(() => interpolatorFromDataset(data)).toThrow(
      /component B_2 not in dataset \(have: B_1\)/,
    );
  });

  it("rejects a component whose length disagrees with the grid", () => {
    const fields = new Map(IDENTITY_FIELD.fields);
    fields.set("B_3", makeField("B_3", new Float64Array(8), [2, 2, 2]));
    expect(() => interpolatorFromDataset({ ...IDENTITY_FIELD, fields })).toThrow(
      /has 8 samples, grid wants 24/,
    );
  });
});

describe("VectorFieldInterpolator.sample", () => {
  it("reproduces a linear field at an interior point (the −0.5 cell-center offset)", () => {
    const point = [13.7, -3.1, 0.4];
    const { ok, out } = sampleAt(point);
    expect(ok).toBe(true);
    assertAllclose(out, point, TOL.interp.ts_f64);
  });

  it("samples the domain edges exactly — t = 0 and t = dim − 1 are the first and last cell centers", () => {
    for (const edge of [LOW, HIGH]) {
      const { ok, out } = sampleAt(edge);
      expect(ok).toBe(true);
      assertAllclose(out, edge, TOL.interp.ts_f64);
    }
  });

  it("returns false and leaves `out` untouched outside the domain", () => {
    // Half a cell outside the last center on each axis in turn — inside the grid's physical box,
    // outside the sampleable region. The NaN sentinel proves no partial write happened.
    const outside = [
      [(LOW[0] ?? 0) - 0.001, LOW[1] ?? 0, LOW[2] ?? 0],
      [HIGH[0] ?? 0, (HIGH[1] ?? 0) + 0.001, HIGH[2] ?? 0],
      [HIGH[0] ?? 0, HIGH[1] ?? 0, (HIGH[2] ?? 0) + 0.001],
    ];
    for (const point of outside) {
      const { ok, out } = sampleAt(point);
      expect(ok).toBe(false);
      expect(Array.from(out).every(Number.isNaN)).toBe(true);
    }
  });

  it("rejects a NaN coordinate rather than sampling garbage", () => {
    const { ok, out } = sampleAt([Number.NaN, -3.1, 0.4]);
    expect(ok).toBe(false);
    expect(Array.from(out).every(Number.isNaN)).toBe(true);
  });
});
