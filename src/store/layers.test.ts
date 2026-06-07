import { describe, expect, it } from "vitest";
import { fieldArray, makeDataset, vectorTriple } from "../../tests/fixtures.ts";
import {
  addLayer,
  type Layer,
  makeDefaultLayer,
  removeLayer,
  reorderLayer,
  setLayerOpacity,
  setLayerShading,
  setLayerVisible,
} from "./layers.ts";
import { createSimulationStore } from "./simulation.ts";

const bDataset = () => vectorTriple("B", { array: Float32Array });

// |B| = 5 and |E| = 10 — two computable magnitudes for the field-switch re-point test.
const beDataset = () =>
  makeDataset({
    B_1: fieldArray("B_1", new Float32Array([3]), [1]),
    B_2: fieldArray("B_2", new Float32Array([4]), [1]),
    B_3: fieldArray("B_3", new Float32Array([0]), [1]),
    E_1: fieldArray("E_1", new Float32Array([6]), [1]),
    E_2: fieldArray("E_2", new Float32Array([8]), [1]),
    E_3: fieldArray("E_3", new Float32Array([0]), [1]),
  });

const slice = (id: string): Layer => makeDefaultLayer(id, "|B|", "slice");
const list = (...ids: string[]): readonly Layer[] => ids.map(slice);

describe("layer helpers", () => {
  it("makes kind defaults: visible, opaque, no binding", () => {
    const vol = makeDefaultLayer("a", "|B|", "volume");
    expect(vol).toEqual({
      id: "a",
      field: "|B|",
      colormapBindingId: null,
      visible: true,
      opacity: 1,
      kind: "volume",
      steps: null,
      density: null,
      shaded: false,
    });
    const slc = makeDefaultLayer("b", "n_e", "slice");
    expect(slc).toMatchObject({ kind: "slice", axis: "z", position: 0.5, field: "n_e" });
  });

  it("addLayer appends a fresh array, preserving prior element identity", () => {
    const a = slice("a");
    const before = [a] as const;
    const after = addLayer(before, slice("b"));
    expect(after).not.toBe(before);
    expect(after.map((l) => l.id)).toEqual(["a", "b"]);
    expect(after[0]).toBe(a); // untouched element keeps identity
  });

  it("removeLayer drops by id; absent id is an identity no-op", () => {
    const before = list("a", "b", "c");
    const after = removeLayer(before, "b");
    expect(after.map((l) => l.id)).toEqual(["a", "c"]);
    expect(removeLayer(before, "zzz")).toBe(before); // no-op → same reference
  });

  it("reorderLayer moves, clamps out-of-range indices, and no-ops on absent/same", () => {
    const before = list("a", "b", "c");
    expect(reorderLayer(before, "a", 2).map((l) => l.id)).toEqual(["b", "c", "a"]);
    expect(reorderLayer(before, "c", -5).map((l) => l.id)).toEqual(["c", "a", "b"]); // clamp lo
    expect(reorderLayer(before, "a", 99).map((l) => l.id)).toEqual(["b", "c", "a"]); // clamp hi
    expect(reorderLayer(before, "a", 0)).toBe(before); // already there → identity
    expect(reorderLayer(before, "zzz", 0)).toBe(before); // absent → identity
  });

  it("setLayerVisible/Opacity touch only the match; no-op on unchanged value", () => {
    const before = list("a", "b");
    const hidden = setLayerVisible(before, "b", false);
    expect(hidden[0]).toBe(before[0]); // sibling identity preserved
    expect(hidden[1]?.visible).toBe(false);
    expect(setLayerVisible(hidden, "b", false)).toBe(hidden); // unchanged → identity

    const faded = setLayerOpacity(before, "a", 0.3);
    expect(faded[0]?.opacity).toBeCloseTo(0.3);
    expect(setLayerOpacity(before, "a", -1)[0]?.opacity).toBe(0); // clamp lo
    expect(setLayerOpacity(before, "a", 9)[0]?.opacity).toBe(1); // clamp hi
  });

  it("setLayerShading flips only a matching volume layer", () => {
    const vol = makeDefaultLayer("v", "|B|", "volume");
    const before = [slice("s"), vol] as const;
    const shaded = setLayerShading(before, "v", true);
    expect(shaded[0]).toBe(before[0]); // sibling identity preserved
    const v = shaded[1];
    expect(v?.kind === "volume" && v.shaded).toBe(true);
    expect(setLayerShading(shaded, "v", true)).toBe(shaded); // unchanged → identity
    expect(setLayerShading(before, "s", true)).toBe(before); // slice has no shading → identity
    expect(setLayerShading(before, "missing", true)).toBe(before); // absent id → identity
  });
});

describe("simulationStore layers", () => {
  it("auto-seeds one volume layer for the active field on setDataset", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const { layers, selectedLayerId } = store.getState();
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      id: "layer-0",
      field: "|B|",
      kind: "volume",
      visible: true,
      opacity: 1,
    });
    expect(selectedLayerId).toBe("layer-0");
  });

  it("does not spawn duplicate layers on a second setDataset", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    store.getState().setDataset(bDataset());
    expect(store.getState().layers).toHaveLength(1);
  });

  it("re-points the selected layer's field on selectField, with a fresh computed", () => {
    const store = createSimulationStore();
    store.getState().setDataset(beDataset());
    const before = store.getState().computed;
    store.getState().selectField("|E|");
    const { layers, computed, activeField } = store.getState();
    expect(activeField).toBe("|E|");
    expect(layers[0]?.field).toBe("|E|");
    expect(computed).not.toBe(before);
  });

  it("selectField to the active field is a no-op on layers", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const before = store.getState().layers;
    store.getState().selectField("|B|");
    expect(store.getState().layers).toBe(before);
  });

  it("addLayer stamps a monotonic id and selects the new layer", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // seeds layer-0
    store.getState().addLayer(makeDefaultLayer("ignored", "|B|", "slice"));
    const { layers, selectedLayerId } = store.getState();
    expect(layers.map((l) => l.id)).toEqual(["layer-0", "layer-1"]);
    expect(selectedLayerId).toBe("layer-1"); // the addLayer-stamped id, not "ignored"
  });

  it("removeLayer of the selected layer reselects the first remaining, then null", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // layer-0 (selected)
    store.getState().addLayer(makeDefaultLayer("x", "|B|", "slice")); // layer-1 (selected)
    store.getState().removeLayer("layer-1");
    expect(store.getState().selectedLayerId).toBe("layer-0");
    store.getState().removeLayer("layer-0");
    expect(store.getState().selectedLayerId).toBeNull();
    expect(store.getState().layers).toHaveLength(0);
  });

  it("removeLayer of a non-selected layer keeps the selection", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // layer-0 (selected)
    store.getState().addLayer(makeDefaultLayer("x", "|B|", "slice")); // layer-1 (selected)
    store.getState().selectLayer("layer-0");
    store.getState().removeLayer("layer-1");
    expect(store.getState().selectedLayerId).toBe("layer-0");
  });

  it("selectLayer(null) deselects; re-selecting the same id is a no-op fire", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    let fires = 0;
    const unsub = store.subscribe(
      (s) => s.selectedLayerId,
      () => fires++,
    );
    store.getState().selectLayer("layer-0"); // already selected → no fire
    store.getState().selectLayer(null); // fires
    unsub();
    expect(fires).toBe(1);
    expect(store.getState().selectedLayerId).toBeNull();
  });

  it("layer mutations notify the layers subscriber with a fresh array", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    const seen: (readonly Layer[])[] = [];
    const unsub = store.subscribe(
      (s) => s.layers,
      (l) => seen.push(l),
    );
    store.getState().setLayerVisible("layer-0", false);
    store.getState().setLayerOpacity("layer-0", 0.5);
    store.getState().reorderLayer("layer-0", 0); // no-op (single element) → no fire
    unsub();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1]?.[0]?.opacity).toBeCloseTo(0.5);
  });

  it("ids reset per store (deterministic, test-isolated)", () => {
    const a = createSimulationStore();
    a.getState().setDataset(bDataset());
    const b = createSimulationStore();
    b.getState().setDataset(bDataset());
    expect(a.getState().layers[0]?.id).toBe("layer-0");
    expect(b.getState().layers[0]?.id).toBe("layer-0");
  });
});
