import { curl, divergence } from "@coordinates/operators.ts";
import { describe, expect, it } from "vitest";
import { smoothVectorField } from "../../../../tests/analyticField.ts";
import { assertAllclose } from "../../../../tests/helpers.ts";
import { RECIPES } from "../../recipes.generated.ts";
import { computeRecipeTs, isTsComputable } from "./index.ts";

// The TS backend's curl/divergence delegate to the single coordinates/operators impl, so on an f64
// dataset the backend output is bit-for-bit the reference — these pin the *plumbing* (input gathering,
// component selection, grid/spacing wiring), not the numerics (covered in coordinates/).
describe("ts backend grid operators", () => {
  const { shape, spacing, f1, f2, f3, dataset } = smoothVectorField({ array: Float64Array });

  it("divergence matches the coordinates twin and packs canonical metadata", () => {
    const out = computeRecipeTs("div_B", dataset);
    expect(out.shape).toEqual([...shape]);
    expect(out.reduction).toBeNull();
    assertAllclose(out.data, divergence(f1, f2, f3, shape, spacing)); // same code path → f64-exact
  });

  it("selects the right curl component per recipe (curl_B_1/2/3 → 0/1/2)", () => {
    // The twin is built with the same anisotropic [0.5, 1, 2] spacing the dataset carries, so a
    // wrong or swapped spacing axis shifts the central-difference scale and fails here.
    const [t1, t2, t3] = curl(f1, f2, f3, shape, spacing);
    assertAllclose(computeRecipeTs("curl_B_1", dataset).data, t1);
    assertAllclose(computeRecipeTs("curl_B_2", dataset).data, t2);
    assertAllclose(computeRecipeTs("curl_B_3", dataset).data, t3);
  });

  it("binds curl/divergence, the same op set as the WGSL backend", () => {
    expect(isTsComputable(RECIPES.curl_B_1)).toBe(true);
    expect(isTsComputable(RECIPES.div_B)).toBe(true);
    expect(isTsComputable(RECIPES.vort_1)).toBe(true); // vorticity = curl V, free coverage
  });

  it("rejects ops it does not bind or whose features are out of scope", () => {
    expect(isTsComputable(RECIPES.beta)).toBe(false); // unbound func (plasma_beta)
    expect(isTsComputable(RECIPES.d_s0)).toBe(false); // needsC + species args
  });

  it("rejects a non-cartesian grid like the coordinates reference", () => {
    const ds = { ...dataset, grid: { ...dataset.grid, geometry: "spherical" as const } };
    expect(() => computeRecipeTs("div_B", ds)).toThrow(/geometry not implemented/);
  });
});
