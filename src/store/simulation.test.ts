import type { FieldArray } from "@containers/field_dataset.ts";
import { describe, expect, it } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { createSimulationStore } from "./simulation.ts";

const bDataset = () => vectorTriple("B", { array: Float32Array });

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
