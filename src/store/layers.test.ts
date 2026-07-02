import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { dummyGrid, fieldArray, makeDataset, vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import {
  addLayer,
  type Layer,
  makeDefaultLayer,
  removeLayer,
  reorderLayer,
  setFieldlineSeeds,
  setLayerOpacity,
  setLayerShading,
  setLayerVisible,
  setSliceAxis,
  setSlicePosition,
} from "./layers.ts";
import { createSimulationStore } from "./simulation.ts";

// A 4³ uniform B = (0,0,1) field: the default rake traces straight lines the tracer resolves, so the
// fieldlines intents (seed count / append / placement) have something real to re-trace.
const traceableDataset = () => {
  const n = 4;
  const size = n * n * n;
  return makeDataset(
    {
      B_1: fieldArray("B_1", new Float64Array(size), [n, n, n]),
      B_2: fieldArray("B_2", new Float64Array(size), [n, n, n]),
      B_3: fieldArray("B_3", new Float64Array(size).fill(1), [n, n, n]),
    },
    { grid: dummyGrid([n, n, n]) },
  );
};

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

  it("setSliceAxis / setSlicePosition touch only a matching slice; clamp + identity", () => {
    const vol = makeDefaultLayer("v", "|B|", "volume");
    const before = [slice("s"), vol] as const;
    const x = setSliceAxis(before, "s", "x");
    expect(x[0]?.kind === "slice" && x[0].axis).toBe("x");
    expect(x[1]).toBe(before[1]); // sibling identity preserved
    expect(setSliceAxis(x, "s", "x")).toBe(x); // unchanged → identity
    expect(setSliceAxis(before, "v", "x")).toBe(before); // non-slice → identity
    expect(setSliceAxis(before, "missing", "x")).toBe(before); // absent → identity

    const moved = setSlicePosition(before, "s", 0.25);
    expect(moved[0]?.kind === "slice" && moved[0].position).toBeCloseTo(0.25);
    expect(setSlicePosition(before, "s", -1)[0]).toMatchObject({ position: 0 }); // clamp lo
    expect(setSlicePosition(before, "s", 9)[0]).toMatchObject({ position: 1 }); // clamp hi
    expect(setSlicePosition(before, "v", 0.3)).toBe(before); // non-slice → identity
  });

  it("setFieldlineSeeds replaces only a matching fieldlines layer; identity on same ref", () => {
    const before = [makeDefaultLayer("f", "|B|", "fieldlines"), slice("s")] as const;
    const seeds: Vec3[] = [
      [0, 0, 0],
      [1, 1, 1],
    ];
    const set = setFieldlineSeeds(before, "f", seeds);
    expect(set[0]?.kind === "fieldlines" && set[0].seeds).toBe(seeds);
    expect(set[1]).toBe(before[1]); // sibling identity preserved
    expect(setFieldlineSeeds(set, "f", seeds)).toBe(set); // same array ref → identity
    expect(setFieldlineSeeds(before, "s", seeds)).toBe(before); // non-fieldlines → identity
  });
});

describe("simulationStore layers", () => {
  it("auto-seeds one volume layer for the active field on setDataset", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
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

  it("does not spawn duplicate layers on a second setDataset", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    store.getState().setDataset(bDataset());
    await flushAsync();
    expect(store.getState().layers).toHaveLength(1);
  });

  it("re-points the selected layer's field on selectField, with a fresh computed", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(beDataset());
    await flushAsync();
    const before = store.getState().computed;
    store.getState().selectField("|E|");
    await flushAsync();
    const { layers, computed, activeField } = store.getState();
    expect(activeField).toBe("|E|");
    expect(layers[0]?.field).toBe("|E|");
    expect(computed).not.toBe(before);
  });

  it("selectField to the active field is a no-op on layers", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    const before = store.getState().layers;
    store.getState().selectField("|B|");
    expect(store.getState().layers).toBe(before);
  });

  it("addLayer stamps a monotonic id and selects the new layer", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // seeds layer-0
    await flushAsync();
    store.getState().addLayer(makeDefaultLayer("ignored", "|B|", "slice"));
    const { layers, selectedLayerId } = store.getState();
    expect(layers.map((l) => l.id)).toEqual(["layer-0", "layer-1"]);
    expect(selectedLayerId).toBe("layer-1"); // the addLayer-stamped id, not "ignored"
  });

  it("removeLayer of the selected layer reselects the first remaining, then null", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // layer-0 (selected)
    await flushAsync();
    store.getState().addLayer(makeDefaultLayer("x", "|B|", "slice")); // layer-1 (selected)
    store.getState().removeLayer("layer-1");
    expect(store.getState().selectedLayerId).toBe("layer-0");
    store.getState().removeLayer("layer-0");
    expect(store.getState().selectedLayerId).toBeNull();
    expect(store.getState().layers).toHaveLength(0);
  });

  it("removeLayer of a non-selected layer keeps the selection", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // layer-0 (selected)
    await flushAsync();
    store.getState().addLayer(makeDefaultLayer("x", "|B|", "slice")); // layer-1 (selected)
    store.getState().selectLayer("layer-0");
    store.getState().removeLayer("layer-1");
    expect(store.getState().selectedLayerId).toBe("layer-0");
  });

  it("selectLayer(null) deselects; re-selecting the same id is a no-op fire", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
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

  it("layer mutations notify the layers subscriber with a fresh array", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
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

  it("ids reset per store (deterministic, test-isolated)", async () => {
    const a = createSimulationStore();
    a.getState().setDataset(bDataset());
    await flushAsync();
    const b = createSimulationStore();
    b.getState().setDataset(bDataset());
    await flushAsync();
    expect(a.getState().layers[0]?.id).toBe("layer-0");
    expect(b.getState().layers[0]?.id).toBe("layer-0");
  });

  it("setSliceAxis / setSlicePosition edit a slice layer in place", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    await flushAsync();
    store.getState().addSliceLayer(); // layer-1 (slice, selected)
    await flushAsync();
    store.getState().setSliceAxis("layer-1", "x");
    store.getState().setSlicePosition("layer-1", 0.2);
    const layer = store.getState().layers.find((l) => l.id === "layer-1");
    expect(layer?.kind === "slice" && layer.axis).toBe("x");
    expect(layer?.kind === "slice" && layer.position).toBeCloseTo(0.2);
  });

  it("setFieldlineSeedCount regenerates the rake (length = count) and retraces", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(traceableDataset());
    await flushAsync();
    store.getState().addFieldlinesLayer(); // layer-1, default rake
    await flushAsync();
    store.getState().setFieldlineSeedCount("layer-1", 5);
    await flushAsync();
    const layer = store.getState().layers.find((l) => l.id === "layer-1");
    expect(layer?.kind === "fieldlines" && layer.seeds.length).toBe(5);
    expect(store.getState().traces["layer-1"]).toBeDefined(); // re-traced
  });

  it("addFieldlineSeed appends one seed (and is inert for a non-fieldlines id)", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(traceableDataset());
    await flushAsync();
    store.getState().addFieldlinesLayer(); // layer-1
    await flushAsync();
    const fl = store.getState().layers.find((l) => l.id === "layer-1");
    const seed = fl?.kind === "fieldlines" ? fl.seeds[0] : undefined;
    if (seed === undefined) throw new Error("expected a seeded rake");
    const before = fl?.kind === "fieldlines" ? fl.seeds.length : 0;
    store.getState().addFieldlineSeed("layer-1", seed); // append an in-domain copy
    store.getState().addFieldlineSeed("layer-0", seed); // volume id → no-op
    await flushAsync();
    const after = store.getState().layers.find((l) => l.id === "layer-1");
    expect(after?.kind === "fieldlines" && after.seeds.length).toBe(before + 1);
  });

  it("setSeedPlacement toggles the mode and clears when its layer is removed", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(traceableDataset());
    await flushAsync();
    store.getState().addFieldlinesLayer(); // layer-1
    await flushAsync();
    store.getState().setSeedPlacement("layer-1");
    expect(store.getState().seedPlacementLayerId).toBe("layer-1");
    store.getState().removeLayer("layer-1");
    expect(store.getState().seedPlacementLayerId).toBeNull(); // don't strand place-mode on a gone layer
  });

  it("kind-specific intents no-op without a dataset (no throw, no layers)", () => {
    const store = createSimulationStore();
    store.getState().setSliceAxis("x", "x");
    store.getState().setSlicePosition("x", 0.5);
    store.getState().setFieldlineSeedCount("x", 4);
    store.getState().addFieldlineSeed("x", [0, 0, 0]);
    expect(store.getState().layers).toHaveLength(0);
  });
});
