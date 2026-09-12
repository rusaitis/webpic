import type { GridInfo } from "@containers/field_dataset.ts";
import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { makeDataset, makeField, makeGrid } from "../../tests/fixtures.ts";
import { assertAllclose } from "../../tests/helpers.ts";
import { averageAlong, destaggerArrayToCellCenters, destaggerToColocated } from "./stagger.ts";

describe("averageAlong", () => {
  it("matches the pypic half-cell-average docstring example", () => {
    // [[1,2,3],[4,5,6]] averaged along axis 1 → [[1.5,2.5],[4.5,5.5]].
    const { data, shape } = averageAlong(new Float64Array([1, 2, 3, 4, 5, 6]), [2, 3], 1);
    expect(shape).toEqual([2, 2]);
    assertAllclose(data, [1.5, 2.5, 4.5, 5.5]);
  });

  it("rejects an out-of-range axis", () => {
    expect(() => averageAlong(new Float64Array([1, 2]), [2], 1)).toThrow(/out of range/);
  });
});

describe("destaggerArrayToCellCenters", () => {
  it("returns the same array when already at cell centers", () => {
    const data = new Float64Array(8).fill(1);
    const out = destaggerArrayToCellCenters(data, [2, 2, 2], [0.5, 0.5, 0.5]);
    expect(out.data).toBe(data);
  });

  it("reproduces a constant field exactly", () => {
    const data = new Float64Array(125).fill(3.14);
    const { data: out, shape } = destaggerArrayToCellCenters(data, [5, 5, 5], [0.5, 0, 0]);
    expect(shape).toEqual([5, 4, 4]);
    expect(out.length).toBe(80);
    for (const v of out) expect(v).toBe(3.14);
  });

  it("reproduces a linear field exactly (f = 3y + 7)", () => {
    const n = 8;
    const data = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) data[i * n + j] = 3 * j + 7;
    }
    const { data: out, shape } = destaggerArrayToCellCenters(data, [n, n], [0.5, 0]);
    expect(shape).toEqual([n, n - 1]);
    const expected = new Float64Array(n * (n - 1));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - 1; j++) expected[i * (n - 1) + j] = 3 * (j + 0.5) + 7;
    }
    assertAllclose(out, expected);
  });

  it("shifts the right axes toward cell centers", () => {
    const zeros = (n: number) => new Float64Array(n);
    expect(destaggerArrayToCellCenters(zeros(1000), [10, 10, 10], [0.5, 0, 0]).shape).toEqual([
      10, 9, 9,
    ]);
    expect(destaggerArrayToCellCenters(zeros(1000), [10, 10, 10], [0.5, 0.5, 0]).shape).toEqual([
      10, 10, 9,
    ]);
    // A node-centered field (0,0,0) is half a cell off on every axis.
    expect(destaggerArrayToCellCenters(zeros(1000), [10, 10, 10], [0, 0, 0]).shape).toEqual([
      9, 9, 9,
    ]);
  });

  it("passes a 1D array through unchanged when already centered, shifts when not", () => {
    const arr = new Float64Array([1, 2, 3, 4]);
    expect(destaggerArrayToCellCenters(arr, [4], [0.5]).data).toBe(arr);
    const { data, shape } = destaggerArrayToCellCenters(arr, [4], [0]);
    expect(shape).toEqual([3]);
    assertAllclose(data, [1.5, 2.5, 3.5]);
  });

  it("rejects a position whose length differs from the array rank", () => {
    expect(() => destaggerArrayToCellCenters(new Float64Array(16), [4, 4], [0.5, 0, 0])).toThrow(
      /length 3 but array/,
    );
  });

  it("rejects offsets outside {0.0, 0.5}", () => {
    expect(() =>
      destaggerArrayToCellCenters(new Float64Array(64), [4, 4, 4], [0.25, 0, 0]),
    ).toThrow(/not in \{0\.0, 0\.5\}/);
  });
});

describe("second-order accuracy", () => {
  // Mismatched x/y frequencies expose the generic O(dx²) error of linear half-cell interp
  // (a single eigenmode would accidentally hit machine precision).
  const maxError = (n: number): number => {
    const length = 2 * Math.PI;
    const dx = length / n;
    const data = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      const xFace = (i + 0.5) * dx;
      for (let j = 0; j < n; j++) data[i * n + j] = Math.cos(xFace) * Math.sin(2 * (j * dx));
    }
    const { data: out } = destaggerArrayToCellCenters(data, [n, n], [0.5, 0]);
    let err = 0;
    for (let i = 0; i < n; i++) {
      const xCell = (i + 0.5) * dx;
      for (let j = 0; j < n - 1; j++) {
        const analytic = Math.cos(xCell) * Math.sin(2 * ((j + 0.5) * dx));
        err = Math.max(err, Math.abs((out[i * (n - 1) + j] ?? Number.NaN) - analytic));
      }
    }
    return err;
  };

  it("converges at second order (error ↓ ~16× per 4× refinement)", () => {
    const e16 = maxError(16);
    const e64 = maxError(64);
    expect(e16).toBeLessThan(0.1);
    expect(e64).toBeLessThan(0.01);
    expect(e16 / e64).toBeGreaterThan(12);
  });
});

// A staggered grid: the shared cell-centered fixture plus the Yee positions under test.
function staggeredGrid(dimensions: number[], position: Record<string, Vec3> | null): GridInfo {
  return {
    ...makeGrid(dimensions),
    stagger:
      position === null
        ? null
        : {
            convention: "staggered",
            fieldLocations: null,
            position,
            interpolationOrder: null,
            notes: null,
          },
  };
}

describe("destaggerToColocated", () => {
  it("returns the same object for a co-located store (no stagger)", () => {
    const ds = makeDataset(
      { B_1: makeField("B_1", new Float64Array(64).fill(1), [4, 4, 4]) },
      { grid: staggeredGrid([4, 4, 4], null) },
    );
    expect(destaggerToColocated(ds)).toBe(ds);
  });

  it("returns the same object when positions are all at cell centers", () => {
    const ds = makeDataset(
      { B_1: makeField("B_1", new Float64Array(64).fill(1), [4, 4, 4]) },
      { grid: staggeredGrid([4, 4, 4], { B_1: [0.5, 0.5, 0.5] }) },
    );
    expect(destaggerToColocated(ds)).toBe(ds);
  });

  it("co-locates a Yee vector field and crops scalars to the common shape", () => {
    const dims = [4, 4, 4];
    const n = 64;
    const ds = makeDataset(
      {
        B_1: makeField("B_1", new Float64Array(n).fill(1), [...dims]),
        B_2: makeField("B_2", new Float64Array(n).fill(2), [...dims]),
        B_3: makeField("B_3", new Float64Array(n).fill(3), [...dims]),
        rho_c: makeField("rho_c", new Float64Array(n).fill(7), [...dims]), // cell-centered scalar, no offset
      },
      {
        grid: staggeredGrid(dims, {
          B_1: [0.5, 0, 0], // x-face
          B_2: [0, 0.5, 0], // y-face
          B_3: [0, 0, 0.5], // z-face
        }),
      },
    );

    const out = destaggerToColocated(ds);
    expect(out).not.toBe(ds);
    expect(out.grid.dimensions).toEqual([3, 3, 3]);
    for (const name of ["B_1", "B_2", "B_3", "rho_c"]) {
      const field = out.fields.get(name);
      expect(field?.shape).toEqual([3, 3, 3]);
      expect(field?.data.length).toBe(27);
    }
    // Constant components survive interpolation + crop exactly.
    expect(Array.from(out.fields.get("B_1")?.data ?? [])).toEqual(new Array(27).fill(1));
    expect(Array.from(out.fields.get("rho_c")?.data ?? [])).toEqual(new Array(27).fill(7));

    expect(out.grid.stagger?.convention).toBe("cell");
    expect(out.grid.stagger?.interpolationOrder).toBe(1);
    expect(out.grid.stagger?.position).toBeNull();
  });

  it("preserves the f32 dtype through destaggering", () => {
    const ds = makeDataset(
      { B_1: makeField("B_1", new Float32Array(64).fill(1), [4, 4, 4]) },
      { grid: staggeredGrid([4, 4, 4], { B_1: [0.5, 0, 0] }) },
    );
    const out = destaggerToColocated(ds);
    expect(out.fields.get("B_1")?.data).toBeInstanceOf(Float32Array);
  });
});
