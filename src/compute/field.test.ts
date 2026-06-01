import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";
import { describe, expect, it } from "vitest";
import { computeField } from "./field.ts";

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

function component(name: string, value: number): FieldArray {
  const meta = fieldInfo(name);
  return {
    data: new Float64Array([value]),
    shape: [1],
    meta,
    units: meta.siUnit,
    latex: meta.latex,
    reduction: null,
  };
}

function bDataset(): FieldDataset {
  return {
    fields: new Map([
      ["B_1", component("B_1", 3)],
      ["B_2", component("B_2", 4)],
      ["B_3", component("B_3", 0)],
    ]),
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
    physics: { gamma: 1, c: Number.POSITIVE_INFINITY, relativistic: false, extra: {} },
    frame: "lab",
    transforms: {},
    metadata: {},
    step: 0,
  };
}

describe("computeField", () => {
  it("computes |B| via the canonical recipe registry", () => {
    const out = computeField("|B|", bDataset());
    expect(Array.from(out.data)).toEqual([5]); // sqrt(3^2 + 4^2)
    expect(out.meta.siUnit).toBe("T");
  });

  it("rejects an unknown recipe name loudly", () => {
    expect(() => computeField("not-a-recipe", bDataset())).toThrow(/unknown recipe/);
  });
});
