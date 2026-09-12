import type { RenderWorkerRequest } from "@render";
import { createSimulationStore, createUiStore, makeDefaultLayer } from "@store";
import { describe, expect, it } from "vitest";
import { makeDataset, makeField, makeGrid } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import { installLayerSync } from "./layerSync.ts";

interface Post {
  readonly message: RenderWorkerRequest;
  readonly transfer: Transferable[] | undefined;
  // Transferable byte sizes captured at post time — the realistic mock detaches the buffers right
  // after, so reading `.byteLength` off the message later would see 0 (as it does in-app).
  readonly transferBytes: readonly number[];
}

// |B| = 5 and |E| = 10 — two computable magnitudes for the field-switch test.
const beDataset = () =>
  makeDataset({
    B_1: makeField("B_1", new Float32Array([3]), [1]),
    B_2: makeField("B_2", new Float32Array([4]), [1]),
    B_3: makeField("B_3", new Float32Array([0]), [1]),
    E_1: makeField("E_1", new Float32Array([6]), [1]),
    E_2: makeField("E_2", new Float32Array([8]), [1]),
    E_3: makeField("E_3", new Float32Array([0]), [1]),
  });

function harness(ready: boolean) {
  const posts: Post[] = [];
  const worker = {
    postMessage: (message: RenderWorkerRequest, transfer?: Transferable[]) => {
      const transferBytes = (transfer ?? []).map((t) =>
        t instanceof ArrayBuffer ? t.byteLength : 0,
      );
      posts.push({ message, transfer, transferBytes });
      // Mirror a real postMessage: transferred ArrayBuffers detach on the sender side, so any later
      // read of one (e.g. a stray .slice on a buffer already handed off) throws — as it does in-app.
      if (transfer !== undefined) {
        for (const item of transfer) {
          if (item instanceof ArrayBuffer) structuredClone(item, { transfer: [item] });
        }
      }
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
    expect(upsert.message.params.layerKind).toBe("volume");
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
    expect(
      upsert.message.params.layerKind === "volume" ? upsert.message.params.shaded : undefined,
    ).toBe(false);
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

  it("posts setSliceParams when an existing slice's axis or position changes (changed field only)", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset()); // layer-0 (volume)
    await flushAsync();
    store.getState().addLayerOfKind("slice"); // layer-1 (slice)
    await flushAsync();
    posts.length = 0; // ignore the add traffic (axis/position ride the upsert)
    store.getState().setSlicePosition("layer-1", 0.2);
    store.getState().setSliceAxis("layer-1", "x");

    const params = posts.map((p) => p.message).filter((m) => m.kind === "setSliceParams");
    expect(params).toHaveLength(2);
    const [pos, axis] = params;
    if (pos?.kind !== "setSliceParams" || axis?.kind !== "setSliceParams") {
      throw new Error("expected two setSliceParams");
    }
    expect(pos.id).toBe("layer-1");
    expect(pos.position).toBe(0.2);
    expect(pos.axis).toBeUndefined(); // only the changed field rides the wire
    expect(axis.axis).toBe("x");
    expect(axis.position).toBeUndefined();
  });

  it("does not post setSliceParams for a freshly added slice (rides the upsert)", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset());
    await flushAsync();
    store.getState().addLayerOfKind("slice");
    await flushAsync();
    expect(kinds(posts)).not.toContain("setSliceParams");
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

  it("upserts a scene for a newly added volume layer (the bridge refills the transferred field)", async () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(beDataset()); // seeds layer-0
    await flushAsync();
    posts.length = 0; // ignore the seed traffic
    store.getState().addLayerOfKind("volume"); // adds layer-1; the seed's buffer was transferred above
    await flushAsync();
    // The bridge sees a new field layer whose buffer was transferred → recomputeField → the field
    // channel upserts every active-field layer; layer-1 must be among them.
    const newUpsert = posts.find(
      (p) => p.message.kind === "upsertLayer" && p.message.id === "layer-1",
    );
    expect(newUpsert).toBeDefined();
  });

  // A 4³ uniform B = (0,0,1) field: the default rake (along x) traces N straight z-lines that the
  // tracer resolves to ≥2 points each — enough to exercise the store→trace→layerSync line path.
  const traceableDataset = () => {
    const n = 4;
    const size = n * n * n;
    return makeDataset(
      {
        B_1: makeField("B_1", new Float64Array(size), [n, n, n]),
        B_2: makeField("B_2", new Float64Array(size), [n, n, n]),
        B_3: makeField("B_3", new Float64Array(size).fill(1), [n, n, n]),
      },
      { grid: makeGrid([n, n, n]) },
    );
  };

  it("traces a field-line layer and posts upsertFieldlines (both buffers transferred)", async () => {
    const { store, posts, sync, setReady } = harness(false);
    store.getState().setDataset(traceableDataset());
    await flushAsync();
    store.getState().addFieldlinesLayer(); // default rake → traces lines into the store
    await flushAsync(); // retrace is async now (owns an AbortController + generation guard)
    expect(Object.keys(store.getState().traces)).toHaveLength(1); // store-side dispatch ran
    setReady(true);
    sync.flushAll();

    // The fieldlines layer shares the active field (|B|) for color, but it must NOT be caught in the
    // scalar-field upsert loop (that sliced the already-transferred buffer → a detached-ArrayBuffer
    // crash). Exactly one upsertLayer (the volume) + one upsertFieldlines.
    expect(kinds(posts).filter((k) => k === "upsertLayer")).toHaveLength(1);

    const up = posts.find((p) => p.message.kind === "upsertFieldlines");
    if (up === undefined || up.message.kind !== "upsertFieldlines") {
      throw new Error("expected an upsertFieldlines");
    }
    expect(up.transfer).toEqual([up.message.positions, up.message.counts]); // transferred, not cloned
    expect(up.transferBytes[0]).toBeGreaterThan(0); // packed positions (captured pre-detach)
    expect(up.transferBytes[1]).toBeGreaterThan(0); // per-line counts
    expect(up.message.color).toHaveLength(4);
    for (const channel of up.message.color) expect(Number.isFinite(channel)).toBe(true);
    expect(up.message.opacity).toBe(1);
  });

  it("flashes the status pill once when a field-line layer traces nothing", async () => {
    const { store, uiStore } = harness(true);
    store.getState().setDataset(traceableDataset());
    await flushAsync();
    store.getState().addFieldlinesLayer();
    await flushAsync();
    expect(uiStore.getState().statusError).toBeNull(); // eight lines traced — nothing to say

    const seen: string[] = [];
    const unsubscribe = uiStore.subscribe(
      (s) => s.statusError,
      (e) => {
        if (e !== null) seen.push(e.message);
      },
    );
    store.getState().setFieldlineSeeds("layer-1", [[100, 100, 100]]); // stale — nothing can trace
    await flushAsync();
    expect(seen).toHaveLength(1);
    store.getState().setFieldlineSeeds("layer-1", [[200, 200, 200]]); // same outcome, same cause
    await flushAsync();
    expect(seen).toHaveLength(1); // said once, not per retrace
    unsubscribe();
  });
});
