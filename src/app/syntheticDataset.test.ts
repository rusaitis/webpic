import { computeField } from "@compute";
import { describe, expect, it } from "vitest";
import { assertAllclose } from "../../tests/helpers.ts";
import { TOL } from "../../tests/tolerances.ts";
import { createSyntheticDataset } from "./syntheticDataset.ts";

const N = 32;
const idx = (ix: number, iy: number, iz: number): number => iz + N * (iy + N * ix);

describe("createSyntheticDataset", () => {
  it("exposes exactly the three B components on a 32³ grid", () => {
    const ds = createSyntheticDataset();
    expect([...ds.fields.keys()].sort()).toEqual(["B_1", "B_2", "B_3"]);
    for (const name of ["B_1", "B_2", "B_3"]) {
      const field = ds.fields.get(name);
      expect(field?.shape).toEqual([N, N, N]);
      expect(field?.data.length).toBe(N * N * N);
    }
    expect(ds.grid.dimensions).toEqual([N, N, N]);
  });

  it("is invariant along z (C-order, z fastest)", () => {
    const b3 = createSyntheticDataset().fields.get("B_3")?.data ?? new Float32Array();
    // B_3 = envelope(x, y) carries no z dependence; each z-column must be constant.
    const ref = b3[idx(3, 5, 0)];
    for (let iz = 0; iz < N; iz++) expect(b3[idx(3, 5, iz)]).toBe(ref);
  });

  it("forms a centered blob: axial B_3 peaks near the center and decays to the corner", () => {
    const b3 = createSyntheticDataset().fields.get("B_3")?.data ?? new Float32Array();
    const nearCenter = b3[idx(15, 15, 0)] ?? 0;
    const corner = b3[idx(0, 0, 0)] ?? 0;
    expect(nearCenter).toBeGreaterThan(corner);
    expect(nearCenter).toBeGreaterThan(0.9); // exp(-small) ≈ 1 at the near-center cell
    expect(nearCenter).toBeLessThanOrEqual(1);
  });

  it("computeField('|B|') matches sqrt(B_1²+B_2²+B_3²) over the whole field", async () => {
    const ds = createSyntheticDataset();
    const mag = await computeField("|B|", ds);
    expect(mag.shape).toEqual([N, N, N]);

    const b1 = ds.fields.get("B_1")?.data ?? new Float32Array();
    const b2 = ds.fields.get("B_2")?.data ?? new Float32Array();
    const b3 = ds.fields.get("B_3")?.data ?? new Float32Array();
    const expected = new Float64Array(b1.length);
    for (let i = 0; i < expected.length; i++) {
      const x = b1[i] ?? 0;
      const y = b2[i] ?? 0;
      const z = b3[i] ?? 0;
      expected[i] = Math.sqrt(x * x + y * y + z * z);
    }
    // f32 storage on both sides → the magnitude single-precision result rounding.
    assertAllclose(mag.data, expected, TOL.magnitude.ts_f32);
  });
});
