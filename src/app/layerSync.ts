import type { FieldArray } from "@containers/field_dataset.ts";
import { REQUEST_IDS, type RenderWorkerRequest } from "@render/messages.ts";
import { type ColormapBinding, DEFAULT_COLORMAP } from "@schema/colormap.ts";
import type { Layer, SimulationStore, UiStore } from "@store";
import { createStoreBridge } from "./storeBridge.ts";

// The loading pill raised while a layer upsert warms its GPU pipeline off the render path (the warm is
// async — compileAsync); the worker's layerCompiled ack drops it. A flat key (v0.1 draws one volume
// layer): a second upsert retitles the same pill, any layerCompiled drops it — like the streaming
// bridge's flat "open"/"step" keys.
const RENDER_PHASE_KEY = "render";

// Bridges the store's instance-first layer registry to the render worker (app-only glue: store and
// render can't import each other). Two channels: `computed` carries field DATA (heavy, transfers the
// buffer), `layers` carries STRUCTURE (removals + the cheap composite of order/visibility/opacity).
// One layer draws the active field for now, so the single `computed` buffer is transferred once;
// per-layer compute will generalize this.

export interface LayerSyncOptions {
  readonly store: SimulationStore;
  /** Raises/drops the render-loading pill across the upsert → layerCompiled round-trip. */
  readonly uiStore: UiStore;
  readonly worker: Pick<Worker, "postMessage">;
  /** Reads the bootstrap `workerReady` flag — nothing is posted until the worker is live. */
  readonly isReady: () => boolean;
}

export interface LayerSync {
  /** Send the full current state (upsert each active-field layer + the composite). Catch-up on ready. */
  readonly flushAll: () => void;
  /** Drop the render-loading pill when the worker acks a layer's pipeline warm (the layerCompiled
   *  response). Coalesced (flat key), so any acked layer clears the shared pill. */
  readonly handleCompiled: () => void;
  readonly dispose: () => void;
}

export function installLayerSync(opts: LayerSyncOptions): LayerSync {
  const { store, uiStore, worker, isReady } = opts;
  const bridge = createStoreBridge(store, isReady);
  let lastLayers: readonly Layer[] = store.getState().layers; // snapshot for the removal diff
  let lastBindings = store.getState().colormapBindings; // snapshot for the per-binding change diff

  // The layer's ColormapBinding, or undefined if it references none (defensive — every renderable
  // layer is seeded with one).
  const bindingFor = (layer: Layer): ColormapBinding | undefined =>
    layer.colormapBindingId !== null
      ? store.getState().colormapBindings[layer.colormapBindingId]
      : undefined;

  const sendUpsert = (layer: Layer, field: FieldArray): void => {
    // Only slice/volume are renderable; fieldlines/particles have no scene yet.
    if (layer.kind !== "slice" && layer.kind !== "volume") return;
    const dtype = field.data instanceof Float64Array ? "f64" : "f32";
    // Freshly computed magnitude → an offset-0 ArrayBuffer (not the SharedArrayBuffer that
    // ArrayBufferLike also admits), so it transfers wholesale.
    const buffer = field.data.buffer as ArrayBuffer;
    const binding = bindingFor(layer);
    const kindParams =
      layer.kind === "slice"
        ? { axis: layer.axis, position: layer.position }
        : {
            shaded: layer.shaded,
            ...(layer.steps !== null ? { steps: layer.steps } : {}),
            ...(layer.density !== null ? { density: layer.density } : {}),
          };
    const request: RenderWorkerRequest = {
      kind: "upsertLayer",
      requestId: REQUEST_IDS.layer,
      id: layer.id,
      layerKind: layer.kind,
      field: { buffer, dtype, shape: field.shape },
      colormap: binding?.colormap ?? DEFAULT_COLORMAP,
      scale: binding?.scale ?? "linear",
      opacity: layer.opacity,
      // The dataset's volume-box aspect — the worker scales the mesh to it (cubic → unit cube). Volume
      // scenes read it; slices ignore it.
      worldHalfExtent: store.getState().worldHalfExtent,
      ...(binding !== undefined ? { windowLevel: binding.window } : {}),
      ...kindParams,
    };
    worker.postMessage(request, [buffer]);
    // The warm (compileAsync) runs off the render path; hold a pill until the worker acks layerCompiled.
    uiStore.getState().beginLoading(RENDER_PHASE_KEY, "preparing render");
  };

  // Live per-layer color update — colormap + window/level + scale, no field transfer.
  const sendLayerColormap = (layer: Layer, binding: ColormapBinding): void => {
    if (layer.kind !== "slice" && layer.kind !== "volume") return;
    const request: RenderWorkerRequest = {
      kind: "setLayerColormap",
      requestId: REQUEST_IDS.layer,
      id: layer.id,
      colormap: binding.colormap,
      windowLevel: binding.window,
      scale: binding.scale,
    };
    worker.postMessage(request);
  };

  // Live per-layer Phong toggle (volume-only) — a uniform flip, no field transfer.
  const sendLayerShading = (layer: Layer): void => {
    if (layer.kind !== "volume") return;
    const request: RenderWorkerRequest = {
      kind: "setLayerShading",
      requestId: REQUEST_IDS.layer,
      id: layer.id,
      shaded: layer.shaded,
    };
    worker.postMessage(request);
  };

  const sendComposite = (): void => {
    const order = store
      .getState()
      .layers.map((layer) => ({ id: layer.id, visible: layer.visible, opacity: layer.opacity }));
    const request: RenderWorkerRequest = {
      kind: "setComposite",
      requestId: REQUEST_IDS.layer,
      order,
    };
    worker.postMessage(request);
  };

  // Upsert every layer drawing the active field (currently the one layer) from `computed`. A
  // transferred buffer detaches, so a second same-field layer gets a copy.
  const upsertActiveField = (computed: FieldArray): void => {
    const { layers, activeField } = store.getState();
    let transferred = false;
    for (const layer of layers) {
      if (layer.field !== activeField) continue;
      if (transferred) {
        sendUpsert(layer, { ...computed, data: computed.data.slice() });
      } else {
        sendUpsert(layer, computed);
        transferred = true;
      }
    }
  };

  const flushAll = (): void => {
    const { computed } = store.getState();
    if (computed !== null) upsertActiveField(computed);
    sendComposite();
  };

  // Data channel — registered before the structure channel so the worker has a layer's scene
  // before any composite references it (a stray reference self-heals on the upsert repaint anyway).
  bridge.subscribe(
    (state) => state.computed,
    (computed) => {
      if (!isReady() || computed === null) return;
      upsertActiveField(computed);
      sendComposite();
    },
  );

  // Structure channel — removals, the per-layer shading toggle, and the cheap composite. No upsert
  // here: a new layer's field data (and its initial `shaded`) ride the same-tick `computed` change
  // (per-layer compute will add a real upsert path).
  bridge.subscribe(
    (state) => state.layers,
    (layers) => {
      if (!isReady()) {
        lastLayers = layers; // keep the snapshot current so a later diff isn't spurious
        return;
      }
      const prevLayers = lastLayers;
      const liveIds = new Set(layers.map((layer) => layer.id));
      for (const prev of prevLayers) {
        if (liveIds.has(prev.id)) continue;
        const request: RenderWorkerRequest = {
          kind: "removeLayer",
          requestId: REQUEST_IDS.layer,
          id: prev.id,
        };
        worker.postMessage(request);
      }
      // Per-layer Phong diff: a brand-new layer's `shaded` rides the upsert, so fire only when an
      // existing volume layer's flag flipped.
      const prevById = new Map(prevLayers.map((layer) => [layer.id, layer]));
      for (const layer of layers) {
        if (layer.kind !== "volume") continue;
        const before = prevById.get(layer.id);
        if (before === undefined) continue; // new layer → its shaded rides the upsert
        if (before.kind === "volume" && before.shaded === layer.shaded) continue;
        sendLayerShading(layer);
      }
      lastLayers = layers;
      sendComposite();
    },
  );

  // Bindings channel — the live color hot path (colormap / window-drag / scale). Diffs the registry
  // by reference and posts setLayerColormap for each layer whose binding object changed. The upsert
  // carries the binding for a fresh layer, so this fires only on edits to an existing one.
  bridge.subscribe(
    (state) => state.colormapBindings,
    (bindings) => {
      if (!isReady()) {
        lastBindings = bindings; // keep the snapshot current so a later diff isn't spurious
        return;
      }
      for (const layer of store.getState().layers) {
        if (layer.colormapBindingId === null) continue;
        const binding = bindings[layer.colormapBindingId];
        const prev = lastBindings[layer.colormapBindingId];
        // Skip a brand-new binding — its color rides the same-tick upsert (seed/field switch). Fire
        // only for edits to an existing one (the colormap / window-drag / scale hot path).
        if (binding === undefined || prev === undefined || binding === prev) continue;
        sendLayerColormap(layer, binding);
      }
      lastBindings = bindings;
    },
  );

  return {
    flushAll,
    handleCompiled() {
      uiStore.getState().endLoading(RENDER_PHASE_KEY);
    },
    dispose() {
      bridge.dispose();
    },
  };
}
