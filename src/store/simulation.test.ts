import type { FieldArray } from "@containers/field_dataset.ts";
import { describe, expect, it } from "vitest";
import { fieldArray, makeDataset, vectorTriple } from "../../tests/fixtures.ts";
import { createSimulationStore } from "./simulation.ts";

const bDataset = () => vectorTriple("B", { array: Float32Array });

// |B| = 5 and |E| = 10 — two computable magnitudes with distinct ranges, for the field-switch test.
const beDataset = () =>
  makeDataset({
    B_1: fieldArray("B_1", new Float32Array([3]), [1]),
    B_2: fieldArray("B_2", new Float32Array([4]), [1]),
    B_3: fieldArray("B_3", new Float32Array([0]), [1]),
    E_1: fieldArray("E_1", new Float32Array([6]), [1]),
    E_2: fieldArray("E_2", new Float32Array([8]), [1]),
    E_3: fieldArray("E_3", new Float32Array([0]), [1]),
  });

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

  it("skips recompute when the field is re-selected (no new array, no re-render)", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const before = store.getState().computed;
    store.getState().selectField("|B|"); // already active
    expect(store.getState().computed).toBe(before); // same reference → subscribers don't fire
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

  it("derives the data range and a full-range window on setDataset", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const { dataRange, windowLevel } = store.getState();
    // |B| = 5 everywhere (constant field) → widened to [5, 6] so the window has finite width.
    expect(dataRange).toEqual({ min: 5, max: 6 });
    expect(windowLevel).toEqual({ center: 5.5, width: 1 });
  });

  it("setWindowLevel updates the window without touching the data range", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    store.getState().setWindowLevel(10, 2);
    const { windowLevel, dataRange } = store.getState();
    expect(windowLevel).toEqual({ center: 10, width: 2 });
    expect(dataRange).toEqual({ min: 5, max: 6 }); // unchanged
  });

  it("resets the window to the new field's full range on a field switch", () => {
    const store = createSimulationStore();
    store.getState().setDataset(beDataset());
    store.getState().setWindowLevel(0, 2); // user-narrowed window on |B|
    store.getState().selectField("|E|"); // |E| = 10 → constant → range [10, 11]
    const { dataRange, windowLevel } = store.getState();
    expect(dataRange).toEqual({ min: 10, max: 11 });
    expect(windowLevel).toEqual({ center: 10.5, width: 1 });
  });

  it("clears the range and window when compute fails", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    store.getState().selectField("not-a-recipe");
    expect(store.getState().dataRange).toBeNull();
    expect(store.getState().windowLevel).toBeNull();
  });
});
