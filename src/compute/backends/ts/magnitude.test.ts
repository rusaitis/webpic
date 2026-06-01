import { describe, expect, it } from "vitest";
import { fieldArray, makeDataset, vectorTriple } from "../../../../tests/fixtures.ts";
import { computeRecipeTs } from "./index.ts";

describe("computeRecipeTs", () => {
  it("computes |B| from B_1/B_2/B_3 with canonical output metadata", () => {
    const out = computeRecipeTs("|B|", vectorTriple("B"));
    expect(Array.from(out.data)).toEqual([5]);
    expect(out.shape).toEqual([1]);
    expect(out.meta.quantityType).toBe("b_field");
    expect(out.meta.siUnit).toBe("T");
    expect(out.units).toBe("T"); // component units preserved
    expect(out.latex).toBe(out.meta.latex);
    expect(out.reduction).toBeNull();
  });

  it.each([
    ["|B|", "B"],
    ["|E|", "E"],
    ["|J|", "J"],
    ["|V|", "V"],
  ] as const)("computes %s across the magnitude family", (recipe, prefix) => {
    expect(Array.from(computeRecipeTs(recipe, vectorTriple(prefix)).data)).toEqual([5]);
  });

  it("throws when a required input field is absent", () => {
    const ds = makeDataset({
      B_1: fieldArray("B_1", new Float64Array([3]), [1]),
      B_2: fieldArray("B_2", new Float64Array([4]), [1]),
    });
    expect(() => computeRecipeTs("|B|", ds)).toThrow(/requires field "B_3"/);
  });

  it("throws when input shapes disagree", () => {
    const ds = makeDataset({
      B_1: fieldArray("B_1", new Float64Array([3]), [1]),
      B_2: fieldArray("B_2", new Float64Array([4, 0]), [2]),
      B_3: fieldArray("B_3", new Float64Array([0]), [1]),
    });
    expect(() => computeRecipeTs("|B|", ds)).toThrow(/mismatched shapes/);
  });

  it("throws for a recipe with no TS op bound", () => {
    // `beta` (plasma_beta) is flag-free but unimplemented on the TS backend; the op
    // lookup fails before inputs are gathered, so an empty dataset suffices.
    expect(() => computeRecipeTs("beta", makeDataset({}))).toThrow(/no TS op bound/);
  });
});
