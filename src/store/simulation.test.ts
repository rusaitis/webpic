import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";
import { describe, expect, it } from "vitest";
import { createSimulationStore } from "./simulation.ts";

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
    data: new Float32Array([value]),
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

describe("simulationStore", () => {
  it("starts empty", () => {
    const store = createSimulationStore();
    const { dataset, computed, status, activeField } = store.getState();
    expect(dataset).toBeNull();
    expect(computed).toBeNull();
    expect(status).toBe("empty");
    expect(activeField).toBe("|B|");
  });

  it("computes the active field on setDataset", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const { computed, status } = store.getState();
    expect(status).toBe("ready");
    expect(computed).not.toBeNull();
    expect(Array.from(computed?.data ?? [])).toEqual([5]);
    expect(computed?.shape).toEqual([1]);
  });

  it("notifies subscribers when the computed field changes", () => {
    const store = createSimulationStore();
    const seen: (FieldArray | null)[] = [];
    const unsubscribe = store.subscribe(
      (s) => s.computed,
      (c) => seen.push(c),
    );
    store.getState().setDataset(bDataset());
    unsubscribe();
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]?.data ?? [])).toEqual([5]);
  });

  it("reports an error for an unknown field without throwing", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    store.getState().selectField("not-a-recipe");
    const { status, error, computed } = store.getState();
    expect(status).toBe("error");
    expect(error).toMatch(/unknown recipe/);
    expect(computed).toBeNull();
  });
});
