import type { FieldArray } from "@containers/field_dataset.ts";
import type { ColormapBinding } from "@schema/colormap.ts";
import { describe, expect, it } from "vitest";
import { fieldArray, makeDataset, vectorTriple } from "../../tests/fixtures.ts";
import { createSimulationStore, type SimulationStore } from "./simulation.ts";

const bDataset = () => vectorTriple("B", { array: Float32Array });

// The binding the selected layer references — the unit the colormap panel + layerSync resolve.
function activeBinding(store: SimulationStore): ColormapBinding | undefined {
  const { selectedLayerId, layers, colormapBindings } = store.getState();
  const id = layers.find((layer) => layer.id === selectedLayerId)?.colormapBindingId;
  return id != null ? colormapBindings[id] : undefined;
}

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

  it("derives the data range and seeds a full-range binding on setDataset", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const { dataRange, layers, selectedLayerId } = store.getState();
    // |B| = 5 everywhere (constant field) → widened to [5, 6] so the window has finite width.
    expect(dataRange).toEqual({ min: 5, max: 6 });
    expect(layers).toHaveLength(1);
    const layer = layers[0];
    expect(layer?.id).toBe(selectedLayerId);
    expect(layer?.colormapBindingId).not.toBeNull(); // seeded, not the pre-M2.5b null
    const binding = activeBinding(store);
    expect(binding).toMatchObject({
      field: "|B|",
      colormap: "inferno",
      scale: "linear",
      window: { center: 5.5, width: 1 },
    });
  });

  it("setBindingWindow updates the binding window without touching the data range", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const id = activeBinding(store)?.id ?? "";
    store.getState().setBindingWindow(id, 10, 2);
    expect(activeBinding(store)?.window).toEqual({ center: 10, width: 2 });
    expect(store.getState().dataRange).toEqual({ min: 5, max: 6 }); // unchanged
  });

  it("setBindingColormap and setBindingScale patch the bound binding", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const id = activeBinding(store)?.id ?? "";
    store.getState().setBindingColormap(id, "viridis");
    store.getState().setBindingScale(id, "log");
    expect(activeBinding(store)).toMatchObject({ colormap: "viridis", scale: "log" });
  });

  it("a no-op binding intent keeps the registry reference (no spurious fire)", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const before = store.getState().colormapBindings;
    store.getState().setBindingColormap(activeBinding(store)?.id ?? "", "inferno"); // already inferno
    expect(store.getState().colormapBindings).toBe(before);
  });

  it("repoints the binding to the new field (full range) on a field switch, keeping the colormap", () => {
    const store = createSimulationStore();
    store.getState().setDataset(beDataset());
    const id = activeBinding(store)?.id ?? "";
    store.getState().setBindingColormap(id, "magma");
    store.getState().setBindingWindow(id, 0, 2); // user-narrowed window on |B|
    store.getState().selectField("|E|"); // |E| = 10 → constant → range [10, 11]
    expect(store.getState().dataRange).toEqual({ min: 10, max: 11 });
    // same binding instance, repointed: field + window reset, colormap preserved.
    expect(activeBinding(store)).toMatchObject({
      field: "|E|",
      colormap: "magma",
      window: { center: 10.5, width: 1 },
    });
  });

  it("clears the range when compute fails (the binding survives the transient error)", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    store.getState().selectField("not-a-recipe");
    expect(store.getState().dataRange).toBeNull();
    expect(store.getState().computed).toBeNull();
    expect(activeBinding(store)).toBeDefined(); // layers/bindings untouched on error
  });
});

describe("simulationStore diagnostics", () => {
  it("starts with no frame timing and continuous measurement off", () => {
    const { frameTimeMs, frameTimeClock, isMeasuringContinuous } =
      createSimulationStore().getState();
    expect(frameTimeMs).toBeNull();
    expect(frameTimeClock).toBeNull();
    expect(isMeasuringContinuous).toBe(false);
  });

  it("setFrameTiming records the latest sample + clock and identity-skips an unchanged one", () => {
    const store = createSimulationStore();
    let fires = 0;
    const unsub = store.subscribe(
      (s) => s.frameTimeMs,
      () => fires++,
    );
    store.getState().setFrameTiming(6.5, "timestamp");
    expect(store.getState()).toMatchObject({ frameTimeMs: 6.5, frameTimeClock: "timestamp" });
    store.getState().setFrameTiming(6.5, "timestamp"); // identical → no fire
    store.getState().setFrameTiming(7.25, "timestamp");
    unsub();
    expect(fires).toBe(2);
    expect(store.getState().frameTimeMs).toBe(7.25);
  });

  it("setMeasuringContinuous toggles and identity-skips a no-op", () => {
    const store = createSimulationStore();
    let fires = 0;
    const unsub = store.subscribe(
      (s) => s.isMeasuringContinuous,
      () => fires++,
    );
    store.getState().setMeasuringContinuous(true);
    store.getState().setMeasuringContinuous(true); // no-op
    store.getState().setMeasuringContinuous(false);
    unsub();
    expect(fires).toBe(2);
    expect(store.getState().isMeasuringContinuous).toBe(false);
  });
});
