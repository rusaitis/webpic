import type { RenderWorkerRequest } from "@render";
import { createSimulationStore, createUiStore, makeDefaultLayer } from "@store";
import { describe, expect, it } from "vitest";
import { fieldArray, makeDataset } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import { installLayerSync } from "./layerSync.ts";

interface Post {
  readonly message: RenderWorkerRequest;
  readonly transfer: Transferable[] | undefined;
}

// |B| = 5 and |E| = 10 — two computable magnitudes for the field-switch test.
const beDataset = () =>
  makeDataset({
    B_1: fieldArray("B_1", new Float32Array([3]), [1]),
    B_2: fieldArray("B_2", new Float32Array([4]), [1]),
    B_3: fieldArray("B_3", new Float32Array([0]), [1]),
    E_1: fieldArray("E_1", new Float32Array([6]), [1]),
    E_2: fieldArray("E_2", new Float32Array([8]), [1]),
    E_3: fieldArray("E_3", new Float32Array([0]), [1]),
  });

function harness(ready: boolean) {
  const posts: Post[] = [];
  const worker = {
    postMessage: (message: RenderWorkerRequest, transfer?: Transferable[]) => {
      posts.push({ message, transfer });
    },
  } as unknown as Worker;
  let isReady = ready;
  const store = createSimulationStore();
  const uiStore = createUiStore();
  const sync = installLayerSync({ store, uiStore, worker, isReady: () => isReady });
  return {
    store,
    posts,
    sync,
    uiStore,
    setReady: (v: boolean) => {
      isReady = v;
    },
  };
}

const kinds = (posts: readonly Post[]) => posts.map((p) => p.message.kind);

describe("installLayerSync", () => {
  it("stays silent until the worker is ready", () => {
    const { store, posts } = harness(false);
    store.getState().setDataset(beDataset()); // seeds layer-0, fires computed + layers
    expect(posts).toHaveLength(0);
  });

  it("flushAll posts the field (transferred) and the composite", async () => {
    const { store, posts, sync, setReady } = harness(false);
    store.getState().setDataset(beDataset());
    await flushAsync();
    setReady(true);
    sync.flushAll();

    const upsert = posts.find((p) => p.message.kind === "upsertLayer");
    if (upsert === undefined || upsert.message.kind !== "upsertLayer") {
      throw new Error("expected an upsertLayer");
    }
    expect(upsert.message.layerKind).toBe("volume");
    expect(upsert.message.field.dtype).toBe("f32");
    expect(upsert.transfer).toEqual([upsert.message.field.buffer]); // transferred, not cloned
    // Colormap/window/scale come from the seeded binding — not the old hardcoded inferno/global.
    expect(upsert.message.colormap).toBe("inferno");
    expect(upsert.message.scale).toBe("linear");
    expect(upsert.message.windowLevel).toEqual({ center: 5.5, width: 1 }); // |B| = 5 → [5, 6]

    const composite = posts.find((p) => p.message.kind === "setComposite");
    if (composite === undefined || composite.message.kind !== "setComposite") {
      throw new Error("expected a setComposite");
    }
    expect(composite.message.order).toEqual([{ id: "layer-0", visible: true, opacity: 1 }]);
  });

  it("re-uploads the field exactly once on a field switch", async () => {
    const { store, posts, setReady } = harness(true);
    store.getState().setDataset(beDataset());
    await flushAsync();
    posts.length = 0; // ignore the initial upload
    setReady(true);
    store.getState().selectField("|E|");
    await flushAsync();

    const upserts = posts.filter((p) => p.message.kind === "upsertLayer");
    expect(upserts).toHaveLength(1); // one layer, one transfer — never a detached double-send
    expect(upserts[0]?.transfer).toHaveLength(1);
  });

  it("rides visibility/opacity changes on setComposite (no field re-transfer)", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset());
    await flushAsync();
    posts.length = 0;
    store.getState().setLayerVisible("layer-0", false);
    store.getState().setLayerOpacity("layer-0", 0.5);
    expect(kinds(posts)).toEqual(["setComposite", "setComposite"]);
    const last = posts[posts.length - 1];
    if (last?.message.kind !== "setComposite") throw new Error("expected setComposite");
    expect(last.message.order[0]).toEqual({ id: "layer-0", visible: false, opacity: 0.5 });
  });

  it("posts setLayerColormap when the bound binding is edited (the live color path)", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset()); // seeds layer-0 + binding-0
    await flushAsync();
    posts.length = 0; // ignore the seed traffic (binding rides the upsert, not this channel)
    const bindingId = store.getState().layers[0]?.colormapBindingId ?? "";
    store.getState().setBindingColormap(bindingId, "viridis");

    const msg = posts.find((p) => p.message.kind === "setLayerColormap");
    if (msg === undefined || msg.message.kind !== "setLayerColormap") {
      throw new Error("expected a setLayerColormap");
    }
    expect(msg.message.id).toBe("layer-0");
    expect(msg.message.colormap).toBe("viridis");
    expect(msg.message.scale).toBe("linear");
    expect(msg.message.windowLevel).toEqual({ center: 5.5, width: 1 });
    expect(msg.transfer).toBeUndefined(); // no field buffer — the live path never re-transfers
  });

  it("does not post setLayerColormap for a freshly seeded binding (rides the upsert)", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset());
    await flushAsync();
    expect(kinds(posts)).not.toContain("setLayerColormap");
  });

  it("upsert carries the volume layer's shaded flag (default off)", async () => {
    const { store, posts, sync, setReady } = harness(false);
    store.getState().setDataset(beDataset());
    await flushAsync();
    setReady(true);
    sync.flushAll();
    const upsert = posts.find((p) => p.message.kind === "upsertLayer");
    if (upsert === undefined || upsert.message.kind !== "upsertLayer") {
      throw new Error("expected an upsertLayer");
    }
    expect(upsert.message.shaded).toBe(false);
  });

  it("posts setLayerShading when an existing volume layer is toggled (no field re-transfer)", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset()); // seeds layer-0 (volume)
    await flushAsync();
    posts.length = 0; // ignore the seed traffic (shaded rides the upsert, not this channel)
    store.getState().setLayerShading("layer-0", true);

    const msg = posts.find((p) => p.message.kind === "setLayerShading");
    if (msg === undefined || msg.message.kind !== "setLayerShading") {
      throw new Error("expected a setLayerShading");
    }
    expect(msg.message.id).toBe("layer-0");
    expect(msg.message.shaded).toBe(true);
    expect(msg.transfer).toBeUndefined(); // uniform flip — never re-transfers the volume
  });

  it("does not post setLayerShading for a freshly seeded layer (rides the upsert)", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset());
    await flushAsync();
    expect(kinds(posts)).not.toContain("setLayerShading");
  });

  it("raises the render-loading pill on an upsert and drops it on the layerCompiled ack", async () => {
    const { store, uiStore, sync, setReady } = harness(false);
    store.getState().setDataset(beDataset());
    await flushAsync();
    setReady(true);
    sync.flushAll(); // posts the seed upsert → its async warm raises the pill
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).toContain("render");
    sync.handleCompiled(); // the worker's layerCompiled ack
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).not.toContain("render");
  });

  it("posts removeLayer when a layer is removed", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset()); // layer-0
    await flushAsync();
    store.getState().addLayer(makeDefaultLayer("ignored", "|B|", "slice")); // layer-1
    posts.length = 0;
    store.getState().removeLayer("layer-1");
    const remove = posts.find((p) => p.message.kind === "removeLayer");
    if (remove === undefined || remove.message.kind !== "removeLayer") {
      throw new Error("expected a removeLayer");
    }
    expect(remove.message.id).toBe("layer-1");
  });
});
