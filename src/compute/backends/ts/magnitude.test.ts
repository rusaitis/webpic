import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";
import { describe, expect, it } from "vitest";
import { computeRecipeTs } from "./index.ts";

function fieldArray(name: string, data: Float64Array, shape: number[]): FieldArray {
  const meta = fieldInfo(name);
  return { data, shape, meta, units: meta.siUnit, latex: meta.latex, reduction: null };
}

const DUMMY_GRID: GridInfo = {
  dimensions: [1],
  spacing: [1],
  origin: [0],
  geometry: "cartesian",
  axisLabels: ["x"],
  dt: null,
  boundary: null,
  survivingAxes: null,
  stagger: null,
};

function makeDataset(fields: Record<string, FieldArray>): FieldDataset {
  return {
    fields: new Map(Object.entries(fields)),
    grid: DUMMY_GRID,
    normalization: {
      lengthRef: 1,
      timeRef: 1,
      velocityRef: 1,
      bFieldRef: 1,
      eFieldRef: 1,
      densityRef: 1,
      massRef: 1,
      chargeRef: 1,
      speedOfLight: Number.POSITIVE_INFINITY,
    },
    species: [],
    physics: { gamma: 5 / 3, c: Number.POSITIVE_INFINITY, relativistic: false, extra: {} },
    frame: "simulation",
    transforms: {},
    metadata: {},
    step: 0,
  };
}

// Build a single-cell dataset with the three components of a vector quantity set to (3,4,0).
function triple(prefix: string): FieldDataset {
  return makeDataset({
    [`${prefix}_1`]: fieldArray(`${prefix}_1`, new Float64Array([3]), [1]),
    [`${prefix}_2`]: fieldArray(`${prefix}_2`, new Float64Array([4]), [1]),
    [`${prefix}_3`]: fieldArray(`${prefix}_3`, new Float64Array([0]), [1]),
  });
}

describe("computeRecipeTs", () => {
  it("computes |B| from B_1/B_2/B_3 with canonical output metadata", () => {
    const out = computeRecipeTs("|B|", triple("B"));
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
    expect(Array.from(computeRecipeTs(recipe, triple(prefix)).data)).toEqual([5]);
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
