import { describe, expect, it } from "vitest";
import { createLayerOrder } from "./order.ts";
import type { FieldSource, LayerEntry } from "./registry.ts";

const POSE = { name: "pose" } as unknown as Parameters<
  ReturnType<typeof createLayerOrder>["items"]
>[1];
const ORTHO = { name: "ortho" } as unknown as typeof POSE;

function entry(kind: "volume" | "slice" | "fieldlines", source: Partial<FieldSource> = {}) {
  return {
    kind,
    scene: { scene: { tag: kind } },
    source: { layerKind: kind, scale: "linear", ...source },
  } as unknown as LayerEntry;
}

const WINDOW = { center: 0.5, width: 1 };

describe("createLayerOrder", () => {
  it("reports only the ids whose opacity moved", () => {
    const composite = createLayerOrder();
    composite.setOrder([
      { id: "a", visible: true, opacity: 1 },
      { id: "b", visible: true, opacity: 1 },
    ]);
    const retuned = composite.setOrder([
      { id: "a", visible: true, opacity: 0.5 },
      { id: "b", visible: true, opacity: 1 },
    ]);
    expect(retuned).toEqual(["a"]);
  });

  it("treats a newly listed id as retuned so its scene gets the opacity", () => {
    const composite = createLayerOrder();
    expect(composite.setOrder([{ id: "a", visible: true, opacity: 0.25 }])).toEqual(["a"]);
    expect(composite.opacityOf("a")).toBe(0.25);
    expect(composite.opacityOf("missing")).toBeUndefined();
  });

  it("draws visible layers in order, each under its kind's camera", () => {
    const composite = createLayerOrder();
    const entries = new Map([
      ["vol", entry("volume")],
      ["sl", entry("slice")],
      ["hidden", entry("volume")],
    ]);
    composite.setOrder([
      { id: "sl", visible: true, opacity: 1 },
      { id: "hidden", visible: false, opacity: 1 },
      { id: "vol", visible: true, opacity: 1 },
    ]);
    const items = composite.items((id) => entries.get(id), POSE, ORTHO);
    expect(items).toHaveLength(2);
    expect(items[0]?.camera).toBe(ORTHO); // slices are screen-aligned
    expect(items[1]?.camera).toBe(POSE);
  });

  it("skips an ordered id whose upsert has not landed yet", () => {
    const composite = createLayerOrder();
    composite.setOrder([{ id: "pending", visible: true, opacity: 1 }]);
    expect(composite.items(() => undefined, POSE, ORTHO)).toEqual([]);
  });

  it("substitutes an override for its id, and appends one the order does not list", () => {
    const composite = createLayerOrder();
    const committed = entry("volume");
    const warming = entry("volume");
    composite.setOrder([{ id: "vol", visible: true, opacity: 1 }]);
    const swapped = composite.items(() => committed, POSE, ORTHO, { id: "vol", entry: warming });
    expect(swapped[0]?.scene).toBe(warming.scene.scene);

    const appended = composite.items(() => committed, POSE, ORTHO, { id: "new", entry: warming });
    expect(appended).toHaveLength(2); // the warming scene must be in the composite it warms
  });

  it("appends into a caller-supplied array so the paint path allocates nothing", () => {
    const composite = createLayerOrder();
    composite.setOrder([{ id: "vol", visible: true, opacity: 1 }]);
    const scratch: Parameters<typeof composite.items>[4] = [];
    expect(composite.items(() => entry("volume"), POSE, ORTHO, undefined, scratch)).toBe(scratch);
    expect(scratch).toHaveLength(1);
  });

  it("picks only visible volume layers, carrying each one's look and the box extent", () => {
    const composite = createLayerOrder();
    const volume = entry("volume", {
      field: { data: new Float32Array(1), shape: [1, 1, 1] },
      params: { layerKind: "volume", density: 3, worldHalfExtent: [1, 2, 3] },
    } as unknown as Partial<FieldSource>);
    const entries = new Map([
      ["sl", entry("slice", { params: { layerKind: "slice" } } as unknown as Partial<FieldSource>)],
      ["vol", volume],
    ]);
    composite.setOrder([
      { id: "sl", visible: true, opacity: 1 },
      { id: "vol", visible: true, opacity: 0.4 },
    ]);
    const { layers, halfExtent } = composite.pickLayers(
      (id) => entries.get(id),
      () => WINDOW,
    );
    expect(layers).toHaveLength(1); // slices are not ray-picked
    expect(layers[0]).toMatchObject({ density: 3, opacity: 0.4, windowLevel: WINDOW });
    expect(halfExtent).toEqual([1, 2, 3]);
  });

  it("falls back to the unit box when no visible volume declares an extent", () => {
    const composite = createLayerOrder();
    composite.setOrder([{ id: "vol", visible: false, opacity: 1 }]);
    const { layers, halfExtent } = composite.pickLayers(
      () => undefined,
      () => WINDOW,
    );
    expect(layers).toEqual([]);
    expect(halfExtent).toEqual([0.5, 0.5, 0.5]);
  });
});
