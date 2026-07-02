import type { FieldArray, GridInfo } from "@containers/field_dataset.ts";
import type { ColormapBinding } from "@schema/colormap.ts";
import { describe, expect, it } from "vitest";
import { fieldArray, makeDataset, vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import {
  createSimulationStore,
  type SimulationStore,
  selectVisibleBindings,
  worldHalfExtentForGrid,
} from "./simulation.ts";

const gridOf = (dimensions: number[], spacing: number[]): GridInfo => ({
  dimensions,
  spacing,
  origin: [0, 0, 0],
  geometry: "cartesian",
  axisLabels: ["x", "y", "z"],
  dt: null,
  boundary: null,
  survivingAxes: null,
  stagger: null,
});

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

  it("computes the active field on setDataset", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const { computed, status } = store.getState();
    expect(status).toBe("ready");
    expect(computed).not.toBeNull();
    expect(Array.from(computed?.data ?? [])).toEqual([5]);
    expect(computed?.shape).toEqual([1]);
  });

  it("notifies subscribers when the computed field changes", async () => {
    const store = createSimulationStore();
    const seen: (FieldArray | null)[] = [];
    const unsubscribe = store.subscribe(
      (s) => s.computed,
      (c) => seen.push(c),
    );
    store.getState().setDataset(bDataset());
    await flushAsync();
    unsubscribe();
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]?.data ?? [])).toEqual([5]);
  });

  it("skips recompute when the field is re-selected (no new array, no re-render)", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const before = store.getState().computed;
    store.getState().selectField("|B|"); // already active (early return — no recompute)
    expect(store.getState().computed).toBe(before); // same reference → subscribers don't fire
  });

  it("reports an error for an unknown field without throwing", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    store.getState().selectField("not-a-recipe");
    const { status, error, computed } = store.getState();
    expect(status).toBe("error");
    expect(error).toMatch(/unknown recipe/);
    expect(computed).toBeNull();
  });

  it("derives the data range and seeds a full-range binding on setDataset", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const { dataRange, layers, selectedLayerId } = store.getState();
    // |B| = 5 everywhere (constant field) → widened to [5, 6] so the window has finite width.
    expect(dataRange).toEqual({ min: 5, max: 6 });
    expect(layers).toHaveLength(1);
    const layer = layers[0];
    expect(layer?.id).toBe(selectedLayerId);
    expect(layer?.colormapBindingId).not.toBeNull(); // the store seeds a binding with each renderable layer
    const binding = activeBinding(store);
    expect(binding).toMatchObject({
      field: "|B|",
      colormap: "inferno",
      scale: "linear",
      window: { center: 5.5, width: 1 },
    });
  });

  it("addVolumeLayer appends a volume on the active field, auto-selects it, mints a binding", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync(); // seeds the first volume layer
    store.getState().addVolumeLayer();
    await flushAsync(); // recompute refills `computed` so the new layer can render
    const { layers, selectedLayerId } = store.getState();
    expect(layers).toHaveLength(2);
    const added = layers[1];
    expect(added?.kind).toBe("volume");
    expect(added?.field).toBe("|B|");
    expect(added?.id).toBe(selectedLayerId); // addLayer auto-selects the new layer
    expect(added?.colormapBindingId).not.toBeNull();
    expect(activeBinding(store)).toMatchObject({ field: "|B|" });
  });

  it("addSliceLayer appends a mid-plane z slice on the active field", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    store.getState().addSliceLayer();
    await flushAsync();
    const added = store.getState().layers[1];
    expect(added).toMatchObject({ kind: "slice", field: "|B|", axis: "z", position: 0.5 });
  });

  it("add-layer intents are no-ops with no dataset", () => {
    const store = createSimulationStore();
    store.getState().addVolumeLayer();
    store.getState().addSliceLayer();
    expect(store.getState().layers).toHaveLength(0);
  });

  it("selectVisibleBindings lists distinct bindings of visible layers in draw order", async () => {
    const store = createSimulationStore();
    expect(selectVisibleBindings(store.getState())).toEqual([]); // no layers yet
    store.getState().setDataset(bDataset());
    await flushAsync();
    store.getState().addVolumeLayer();
    await flushAsync();
    const [first, second] = store.getState().layers;
    expect(selectVisibleBindings(store.getState()).map((b) => b.id)).toEqual([
      first?.colormapBindingId,
      second?.colormapBindingId,
    ]);
    // A third layer sharing the first binding adds no entry (shared bindings collapse to one)...
    store.getState().addLayer({
      kind: "volume",
      field: "|B|",
      colormapBindingId: first?.colormapBindingId ?? null,
      visible: true,
      opacity: 1,
      steps: null,
      density: null,
      shaded: false,
    });
    expect(selectVisibleBindings(store.getState())).toHaveLength(2);
    // ...and hiding a layer drops its binding from the set.
    store.getState().setLayerVisible(second?.id ?? "", false);
    expect(selectVisibleBindings(store.getState()).map((b) => b.id)).toEqual([
      first?.colormapBindingId,
    ]);
  });

  it("setBindingWindow updates the binding window without touching the data range", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const id = activeBinding(store)?.id ?? "";
    store.getState().setBindingWindow(id, 10, 2);
    expect(activeBinding(store)?.window).toEqual({ center: 10, width: 2 });
    expect(store.getState().dataRange).toEqual({ min: 5, max: 6 }); // unchanged
  });

  it("setBindingColormap and setBindingScale patch the bound binding", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const id = activeBinding(store)?.id ?? "";
    store.getState().setBindingColormap(id, "viridis");
    store.getState().setBindingScale(id, "log");
    expect(activeBinding(store)).toMatchObject({ colormap: "viridis", scale: "log" });
  });

  it("a no-op binding intent keeps the registry reference (no spurious fire)", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const before = store.getState().colormapBindings;
    store.getState().setBindingColormap(activeBinding(store)?.id ?? "", "inferno"); // already inferno
    expect(store.getState().colormapBindings).toBe(before);
  });

  it("repoints the binding to the new field (full range) on a field switch, keeping the colormap", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(beDataset());
    await flushAsync();
    const id = activeBinding(store)?.id ?? "";
    store.getState().setBindingColormap(id, "magma");
    store.getState().setBindingWindow(id, 0, 2); // user-narrowed window on |B|
    store.getState().selectField("|E|"); // |E| = 10 → constant → range [10, 11]
    await flushAsync();
    expect(store.getState().dataRange).toEqual({ min: 10, max: 11 });
    // same binding instance, repointed: field + window reset, colormap preserved.
    expect(activeBinding(store)).toMatchObject({
      field: "|E|",
      colormap: "magma",
      window: { center: 10.5, width: 1 },
    });
  });

  it("clears the range when compute fails (the binding survives the transient error)", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    store.getState().selectField("not-a-recipe");
    expect(store.getState().dataRange).toBeNull();
    expect(store.getState().computed).toBeNull();
    expect(activeBinding(store)).toBeDefined(); // layers/bindings untouched on error
  });
});

describe("simulationStore fly mode", () => {
  it("defaults to orbit (fly off)", () => {
    expect(createSimulationStore().getState().isFlyMode).toBe(false);
  });

  it("toggleFlyMode flips it; setFlyMode is a guarded no-fire on an unchanged value", () => {
    const store = createSimulationStore();
    let fires = 0;
    const unsubscribe = store.subscribe(
      (s) => s.isFlyMode,
      () => fires++,
    );
    store.getState().toggleFlyMode();
    expect(store.getState().isFlyMode).toBe(true);
    store.getState().setFlyMode(true); // unchanged → no fire
    store.getState().setFlyMode(false);
    expect(store.getState().isFlyMode).toBe(false);
    unsubscribe();
    expect(fires).toBe(2); // toggle on + set off, the redundant set elided
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

describe("worldHalfExtentForGrid", () => {
  it("is the unit box for a cubic grid (cubic datasets render unchanged)", () => {
    expect(worldHalfExtentForGrid(gridOf([32, 32, 32], [1, 1, 1]))).toEqual([0.5, 0.5, 0.5]);
  });

  it("normalizes a non-cubic grid so the longest axis is 0.5 (the dipole aspect)", () => {
    const h = worldHalfExtentForGrid(gridOf([150, 100, 100], [0.1, 0.1, 0.1])); // spans 15, 10, 10
    expect(h[0]).toBeCloseTo(0.5, 12);
    expect(h[1]).toBeCloseTo(1 / 3, 12);
    expect(h[2]).toBeCloseTo(1 / 3, 12);
  });

  it("falls back to voxel-index spans when spacing is unusable", () => {
    expect(worldHalfExtentForGrid(gridOf([10, 4, 2], [0, 0, 0]))).toEqual([0.5, 0.2, 0.1]);
  });
});

describe("selectDataset", () => {
  it("records the id and no-ops on the same id", () => {
    const store = createSimulationStore();
    expect(store.getState().datasetId).toBe("fluxrope");
    let fires = 0;
    const unsub = store.subscribe(
      (s) => s.datasetId,
      () => fires++,
    );
    store.getState().selectDataset("dipole");
    expect(store.getState().datasetId).toBe("dipole");
    store.getState().selectDataset("dipole"); // unchanged → no fire
    expect(fires).toBe(1);
    unsub();
  });
});

describe("setDataset", () => {
  it("derives worldHalfExtent from the loaded grid", () => {
    const store = createSimulationStore();
    expect(store.getState().worldHalfExtent).toEqual([0.5, 0.5, 0.5]); // default unit box
    const fields = {
      B_1: fieldArray("B_1", new Float32Array([1]), [1]),
      B_2: fieldArray("B_2", new Float32Array([0]), [1]),
      B_3: fieldArray("B_3", new Float32Array([0]), [1]),
    };
    store
      .getState()
      .setDataset(makeDataset(fields, { grid: gridOf([150, 100, 100], [0.1, 0.1, 0.1]) }));
    const h = store.getState().worldHalfExtent;
    expect(h[0]).toBeCloseTo(0.5, 12);
    expect(h[1]).toBeCloseTo(1 / 3, 12);
    expect(h[2]).toBeCloseTo(1 / 3, 12);
  });
});
