import type { FieldLine } from "@compute";
import { createSimulationStore, createUiStore } from "@store";
import { describe, expect, it } from "vitest";
import { makeField, vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import { createLayerUpserts } from "./layerUpserts.ts";

function rig() {
  const posts: Array<{ message: Record<string, unknown>; transfer?: unknown[] }> = [];
  const worker = {
    postMessage: (message: Record<string, unknown>, transfer?: unknown[]): void => {
      posts.push(transfer ? { message, transfer } : { message });
    },
  } as unknown as Pick<Worker, "postMessage">;
  const store = createSimulationStore();
  const uiStore = createUiStore();
  const upserts = createLayerUpserts({ store, uiStore, worker });
  return { posts, store, uiStore, upserts };
}

const volumeLayer = (id = "layer-0") =>
  ({
    id,
    kind: "volume",
    field: "|B|",
    colormapBindingId: null,
    visible: true,
    opacity: 0.5,
    steps: null,
    density: null,
    shaded: true,
  }) as const;

describe("createLayerUpserts", () => {
  it("transfers a field layer's scalar and raises the render pill", async () => {
    const { posts, uiStore, upserts } = rig();
    const field = makeField("|B|", new Float32Array(8), [2, 2, 2]);
    upserts.sendUpsert(volumeLayer(), field);
    await flushAsync();

    const post = posts[0];
    expect(post?.message.kind).toBe("upsertLayer");
    expect(post?.transfer).toEqual([field.data.buffer]); // moved, not cloned
    expect(post?.message).toMatchObject({ opacity: 0.5, params: { layerKind: "volume" } });
    expect(upserts.fieldUpserted.has("layer-0")).toBe(true);
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).toContain("render");
  });

  it("ignores a field-lines layer on the scalar path — it draws polylines", () => {
    const { posts, upserts } = rig();
    const layer = { ...volumeLayer(), kind: "fieldlines", seeds: [] } as unknown as Parameters<
      typeof upserts.sendUpsert
    >[0];
    upserts.sendUpsert(layer, makeField("|B|", new Float32Array(8), [2, 2, 2]));
    expect(posts).toEqual([]);
  });

  it("sends only the slice field that changed", () => {
    const { posts, upserts } = rig();
    const slice = {
      ...volumeLayer(),
      kind: "slice",
      axis: "z",
      position: 0.25,
    } as unknown as Parameters<typeof upserts.sendSliceParams>[0];
    upserts.sendSliceParams(slice, { axis: false, position: true });
    expect(posts[0]?.message).toMatchObject({ kind: "setSliceParams", position: 0.25 });
    expect(posts[0]?.message).not.toHaveProperty("axis");
  });

  it("drops a removed layer from the upserted set so a re-add re-sends its field", () => {
    const { posts, upserts } = rig();
    upserts.sendUpsert(volumeLayer(), makeField("|B|", new Float32Array(8), [2, 2, 2]));
    upserts.sendRemove("layer-0");
    expect(upserts.fieldUpserted.has("layer-0")).toBe(false);
    expect(posts.at(-1)?.message).toMatchObject({ kind: "removeLayer", id: "layer-0" });
  });

  it("packs traced lines into world space and transfers both buffers", async () => {
    const { posts, store, upserts } = rig();
    store.getState().setDataset(vectorTriple("B", { dims: [4, 4, 4] }));
    await flushAsync();
    const lines: FieldLine[] = [
      { nPoints: 2, points: new Float64Array([0, 0, 0, 1, 1, 1]) } as unknown as FieldLine,
    ];
    const layer = { ...volumeLayer(), kind: "fieldlines", seeds: [] } as unknown as Parameters<
      typeof upserts.sendUpsertFieldlines
    >[0];
    upserts.sendUpsertFieldlines(layer, lines);

    const post = posts.at(-1);
    expect(post?.message.kind).toBe("upsertFieldlines");
    expect(post?.transfer).toHaveLength(2); // positions + counts both move
    expect(new Uint32Array(post?.message.counts as ArrayBuffer)).toEqual(new Uint32Array([2]));
  });

  it("mirrors the store's layer order onto the composite wire", async () => {
    const { posts, store, upserts } = rig();
    store.getState().setDataset(vectorTriple("B", { dims: [4, 4, 4] }));
    await flushAsync();
    upserts.sendComposite();
    const order = posts.at(-1)?.message.order as Array<{ id: string }>;
    expect(order.map((entry) => entry.id)).toEqual(store.getState().layers.map((l) => l.id));
  });
});
