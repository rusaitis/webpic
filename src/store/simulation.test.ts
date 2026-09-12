import type { FieldArray, GridInfo } from "@containers/field_dataset.ts";
import type { ColormapBinding } from "@schema/colormap.ts";
import { describe, expect, it } from "vitest";
import { makeDataset, makeField, makeGrid, vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import {
  createSimulationStore,
  type SimulationStore,
  selectComputed,
  selectDataRange,
  selectVisibleBindings,
} from "./simulation.ts";

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
    B_1: makeField("B_1", new Float32Array([3]), [1]),
    B_2: makeField("B_2", new Float32Array([4]), [1]),
    B_3: makeField("B_3", new Float32Array([0]), [1]),
    E_1: makeField("E_1", new Float32Array([6]), [1]),
    E_2: makeField("E_2", new Float32Array([8]), [1]),
    E_3: makeField("E_3", new Float32Array([0]), [1]),
  });

describe("simulationStore", () => {
  it("starts empty", () => {
    const store = createSimulationStore();
    const { dataset, field, activeField } = store.getState();
    expect(dataset).toBeNull();
    expect(selectComputed(store.getState())).toBeNull();
    expect(field.kind).toBe("empty");
    expect(activeField).toBe("|B|");
  });

  it("computes the active field on setDataset", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const { field } = store.getState();
    expect(field.kind).toBe("ready");
    const computed = selectComputed(store.getState());
    expect(computed).not.toBeNull();
    expect(Array.from(computed?.data ?? [])).toEqual([5]);
    expect(computed?.shape).toEqual([1]);
  });

  it("notifies subscribers when the computed field changes", async () => {
    const store = createSimulationStore();
    const seen: (FieldArray | null)[] = [];
    const unsubscribe = store.subscribe(selectComputed, (c) => seen.push(c));
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
    const before = selectComputed(store.getState());
    store.getState().selectField("|B|"); // already active (early return — no recompute)
    expect(selectComputed(store.getState())).toBe(before); // same reference → subscribers don't fire
  });

  it("reports an error for an unknown field without throwing", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    store.getState().selectField("not-a-recipe");
    const { field } = store.getState();
    expect(field.kind).toBe("error");
    expect(field.kind === "error" ? field.message : "").toMatch(/unknown recipe/);
    const computed = selectComputed(store.getState());
    expect(computed).toBeNull();
  });

  it("derives the data range and seeds a full-range binding on setDataset", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const { layers, selectedLayerId } = store.getState();
    const dataRange = selectDataRange(store.getState());
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
    expect(selectDataRange(store.getState())).toEqual({ min: 5, max: 6 }); // unchanged
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
    expect(selectDataRange(store.getState())).toEqual({ min: 10, max: 11 });
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
    expect(selectDataRange(store.getState())).toBeNull();
    expect(selectComputed(store.getState())).toBeNull();
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

describe("setDataset — field-line seeds across a switch", () => {
  // Seeds are physical coordinates: a rake laid on one grid means nothing on another. Without the
  // re-rake every seed lands outside the new domain and the layer traces nothing at all.
  const gridA = () => makeGrid([4, 4, 4], [1, 1, 1]);
  const traceableOn = (grid: GridInfo, origin: readonly number[] = [0, 0, 0]) => {
    const size = grid.dimensions.reduce((a, b) => a * b, 1);
    return makeDataset(
      {
        B_1: makeField("B_1", new Float64Array(size), grid.dimensions),
        B_2: makeField("B_2", new Float64Array(size), grid.dimensions),
        B_3: makeField("B_3", new Float64Array(size).fill(1), grid.dimensions),
      },
      { grid: { ...grid, origin: [...origin] } },
    );
  };

  it("re-rakes a layer whose seeds all miss the new grid", async () => {
    const store = createSimulationStore();
    await store.getState().setDataset(traceableOn(gridA()));
    store.getState().addFieldlinesLayer();
    await flushAsync();
    const before = store.getState().layers.find((l) => l.id === "layer-1");
    expect(before?.kind === "fieldlines" && before.seeds[0]?.[0]).toBe(0.5);

    await store.getState().setDataset(traceableOn(gridA(), [100, 100, 100]));
    await flushAsync();
    const after = store.getState().layers.find((l) => l.id === "layer-1");
    expect(after?.kind === "fieldlines" && after.seeds).toHaveLength(8);
    expect(after?.kind === "fieldlines" && after.seeds[0]?.[0]).toBe(100.5);
    expect(store.getState().traces["layer-1"]).toHaveLength(8);
    expect(store.getState().traceNotices["layer-1"]?.traced).toBe(8);
  });

  it("leaves a layer whose seeds still land in the new grid alone", async () => {
    const store = createSimulationStore();
    await store.getState().setDataset(traceableOn(gridA()));
    store.getState().addFieldlinesLayer();
    await flushAsync();
    store.getState().setFieldlineSeeds("layer-1", [[2, 2, 2]]);
    await flushAsync();
    await store.getState().setDataset(traceableOn(makeGrid([8, 8, 8], [1, 1, 1])));
    await flushAsync();
    const layer = store.getState().layers.find((l) => l.id === "layer-1");
    expect(layer?.kind === "fieldlines" && layer.seeds).toEqual([[2, 2, 2]]); // the placed seed survives
  });
});

describe("setDataset", () => {
  it("derives worldHalfExtent from the loaded grid", () => {
    const store = createSimulationStore();
    expect(store.getState().worldHalfExtent).toEqual([0.5, 0.5, 0.5]); // default unit box
    const fields = {
      B_1: makeField("B_1", new Float32Array([1]), [1]),
      B_2: makeField("B_2", new Float32Array([0]), [1]),
      B_3: makeField("B_3", new Float32Array([0]), [1]),
    };
    store
      .getState()
      .setDataset(makeDataset(fields, { grid: makeGrid([150, 100, 100], [0.1, 0.1, 0.1]) }));
    const h = store.getState().worldHalfExtent;
    expect(h[0]).toBeCloseTo(0.5, 12);
    expect(h[1]).toBeCloseTo(1 / 3, 12);
    expect(h[2]).toBeCloseTo(1 / 3, 12);
  });
});

describe("simulationStore picker", () => {
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
