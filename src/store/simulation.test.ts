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

describe("simulationStore time cursor", () => {
  it("starts at step 0 with an empty domain", () => {
    const { currentStep, availableSteps } = createSimulationStore().getState();
    expect(currentStep).toBe(0);
    expect(availableSteps).toEqual([]);
  });

  it("tracks the loaded step and seeds a 1-element domain on setDataset", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // fixture step = 0
    expect(store.getState().currentStep).toBe(0);
    expect(store.getState().availableSteps).toEqual([0]); // a direct load gets a valid cursor domain
  });

  it("setAvailableSteps replaces the domain and keeps a reader-populated list across reloads", () => {
    const store = createSimulationStore();
    store.getState().setAvailableSteps([0, 1, 2, 3, 4]);
    expect(store.getState().availableSteps).toEqual([0, 1, 2, 3, 4]);
    store.getState().setDataset(bDataset()); // non-empty domain survives — setDataset doesn't clobber it
    expect(store.getState().availableSteps).toEqual([0, 1, 2, 3, 4]);
  });

  it("setStep moves the cursor, ignores an out-of-domain step, and identity-skips a no-op", () => {
    const store = createSimulationStore();
    store.getState().setAvailableSteps([0, 2, 4]);
    let fires = 0;
    const unsub = store.subscribe(
      (s) => s.currentStep,
      () => fires++,
    );
    store.getState().setStep(2);
    expect(store.getState().currentStep).toBe(2);
    store.getState().setStep(2); // unchanged → no fire
    store.getState().setStep(3); // not in [0,2,4] → ignored
    unsub();
    expect(store.getState().currentStep).toBe(2);
    expect(fires).toBe(1);
  });

  it("setAvailableSteps snaps the cursor into the new domain and identity-skips an identical one", () => {
    const store = createSimulationStore();
    store.getState().setAvailableSteps([0, 10, 20, 30]);
    store.getState().setStep(30);
    let fires = 0;
    const unsub = store.subscribe(
      (s) => s.availableSteps,
      () => fires++,
    );
    store.getState().setAvailableSteps([0, 5, 10]); // 30 is gone → snap to the nearest survivor (10)
    expect(store.getState().currentStep).toBe(10);
    store.getState().setAvailableSteps([0, 5, 10]); // identical domain → no fire
    unsub();
    expect(fires).toBe(1);
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

  it("seeds the picker at box center, visible, and moves it on setPickerPoint", () => {
    const store = createSimulationStore();
    expect(store.getState().pickerPoint).toEqual([0, 0, 0]);
    expect(store.getState().overlay.showPicker).toBe(true);
    store.getState().setPickerPoint([0.2, -0.3, 0.1]);
    expect(store.getState().pickerPoint).toEqual([0.2, -0.3, 0.1]);
    store.getState().setPickerPoint(null);
    expect(store.getState().pickerPoint).toBeNull();
  });

  it("setPickerHover / setPickerActive / setOverlayShowPicker identity-skip no-ops", () => {
    const store = createSimulationStore();
    let hover = 0;
    let active = 0;
    let show = 0;
    const unsubH = store.subscribe(
      (s) => s.pickerHover,
      () => hover++,
    );
    const unsubA = store.subscribe(
      (s) => s.pickerActive,
      () => active++,
    );
    const unsubS = store.subscribe(
      (s) => s.overlay.showPicker,
      () => show++,
    );
    store.getState().setPickerHover("core");
    store.getState().setPickerHover("core"); // no-op
    store.getState().setPickerActive(true);
    store.getState().setPickerActive(true); // no-op
    store.getState().setOverlayShowPicker(false);
    store.getState().setOverlayShowPicker(false); // no-op
    unsubH();
    unsubA();
    unsubS();
    expect([hover, active, show]).toEqual([1, 1, 1]);
    expect(store.getState().pickerHover).toBe("core");
    expect(store.getState().pickerActive).toBe(true);
    expect(store.getState().overlay.showPicker).toBe(false);
  });

  it("requestPick carries the purpose and clears on consume", () => {
    const store = createSimulationStore();
    store.getState().requestPick({ ndcX: 0.1, ndcY: 0.2, aspect: 1.5, purpose: "place" });
    expect(store.getState().pickRequest).toEqual({
      ndcX: 0.1,
      ndcY: 0.2,
      aspect: 1.5,
      purpose: "place",
    });
    store.getState().requestPick(null);
    expect(store.getState().pickRequest).toBeNull();
  });
});
