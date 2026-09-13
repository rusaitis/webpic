import type { FieldLine } from "@compute";
import { createSimulationStore, createUiStore } from "@store";
import { describe, expect, it } from "vitest";
import { makeField, vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import { createLayerMessages } from "./layerMessages.ts";

function rig() {
  const posts: Array<{ message: Record<string, unknown>; transfer?: unknown[] }> = [];
  const worker = {
    postMessage: (message: Record<string, unknown>, transfer?: unknown[]): void => {
      posts.push(transfer ? { message, transfer } : { message });
    },
  } as unknown as Pick<Worker, "postMessage">;
  const store = createSimulationStore();
  const uiStore = createUiStore();
  const send = createLayerMessages({ store, uiStore, worker });
  return { posts, store, uiStore, send };
}

const layerBase = (id: string) =>
  ({ id, field: "|B|", colormapBindingId: null, visible: true, opacity: 0.5 }) as const;

const volumeLayer = (id = "layer-0") =>
  ({ ...layerBase(id), kind: "volume", steps: null, density: null, shaded: true }) as const;

const sliceLayer = (id = "layer-0") =>
  ({ ...layerBase(id), kind: "slice", axis: "z", position: 0.25 }) as const;

const fieldlinesLayer = (id = "layer-0") =>
  ({ ...layerBase(id), kind: "fieldlines", seeds: [] }) as const;

describe("createLayerMessages", () => {
  it("transfers a field layer's scalar and raises the render pill", async () => {
    const { posts, uiStore, send } = rig();
    const field = makeField("|B|", new Float32Array(8), [2, 2, 2]);
    send.upsert(volumeLayer(), field);
    await flushAsync();

    const post = posts[0];
    expect(post?.message.kind).toBe("upsertLayer");
    expect(post?.transfer).toEqual([field.data.buffer]); // moved, not cloned
    expect(post?.message).toMatchObject({ opacity: 0.5, params: { layerKind: "volume" } });
    expect(send.fieldUpserted.has("layer-0")).toBe(true);
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).toContain("render");
  });

  it("sends only the slice field that changed", () => {
    const { posts, send } = rig();
    send.sliceParams(sliceLayer(), { hasAxisChanged: false, hasPositionChanged: true });
    expect(posts[0]?.message).toMatchObject({ kind: "setSliceParams", position: 0.25 });
    expect(posts[0]?.message).not.toHaveProperty("axis");
  });

  it("drops a removed layer from the upserted set so a re-add re-sends its field", () => {
    const { posts, send } = rig();
    send.upsert(volumeLayer(), makeField("|B|", new Float32Array(8), [2, 2, 2]));
    send.remove("layer-0");
    expect(send.fieldUpserted.has("layer-0")).toBe(false);
    expect(posts.at(-1)?.message).toMatchObject({ kind: "removeLayer", id: "layer-0" });
  });

  it("packs traced lines into world space and transfers both buffers", async () => {
    const { posts, store, send } = rig();
    store.getState().setDataset(vectorTriple("B", { dims: [4, 4, 4] }));
    await flushAsync();
    const lines: FieldLine[] = [
      { nPoints: 2, points: new Float64Array([0, 0, 0, 1, 1, 1]) } as unknown as FieldLine,
    ];
    send.upsertFieldlines(fieldlinesLayer(), lines);

    const post = posts.at(-1);
    expect(post?.message.kind).toBe("upsertFieldlines");
    expect(post?.transfer).toHaveLength(2); // positions + counts both move
    expect(new Uint32Array(post?.message.counts as ArrayBuffer)).toEqual(new Uint32Array([2]));
  });

  it("mirrors the store's layer order onto the composite wire", async () => {
    const { posts, store, send } = rig();
    store.getState().setDataset(vectorTriple("B", { dims: [4, 4, 4] }));
    await flushAsync();
    send.composite();
    const order = posts.at(-1)?.message.order as Array<{ id: string }>;
    expect(order.map((entry) => entry.id)).toEqual(store.getState().layers.map((l) => l.id));
  });
});
