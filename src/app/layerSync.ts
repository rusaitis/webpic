import type { FieldArray } from "@containers/field_dataset.ts";
import type { RenderWorkerRequest } from "@render";
import { type ColormapBinding, DEFAULT_COLORMAP } from "@schema/colormap.ts";
import type { Layer, SimulationStore } from "@store";

// Bridges the store's instance-first layer registry to the render worker (app-only: it imports both
// @store and @render, which the DAG forbids either of them from doing). Two channels: `computed`
// carries field DATA (heavy, transfers the buffer), `layers` carries STRUCTURE (removals + the
// cheap composite of order/visibility/opacity). Pre-M4 exactly one layer draws the active field, so
// the single `computed` buffer is transferred once; M4's per-layer compute generalizes this.

const LAYER_REQUEST_ID = 4;

export interface LayerSyncOptions {
  readonly store: SimulationStore;
  readonly worker: Pick<Worker, "postMessage">;
  /** Reads the bootstrap `workerReady` flag — nothing is posted until the worker is live. */
  readonly isReady: () => boolean;
}

export interface LayerSync {
  /** Send the full current state (upsert each active-field layer + the composite). Catch-up on ready. */
  readonly flushAll: () => void;
  readonly dispose: () => void;
}

export function installLayerSync(opts: LayerSyncOptions): LayerSync {
  const { store, worker, isReady } = opts;
  let lastLayers: readonly Layer[] = store.getState().layers; // snapshot for the removal diff
  let lastBindings = store.getState().colormapBindings; // snapshot for the per-binding change diff

  // The layer's ColormapBinding, or undefined if it references none (defensive — post-M2.5b every
  // renderable layer is seeded with one).
  const bindingFor = (layer: Layer): ColormapBinding | undefined =>
    layer.colormapBindingId !== null
      ? store.getState().colormapBindings[layer.colormapBindingId]
      : undefined;

  const sendUpsert = (layer: Layer, field: FieldArray): void => {
    // Only slice/volume are renderable; fieldlines/particles (M4/M5) have no scene yet.
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
      requestId: LAYER_REQUEST_ID,
      id: layer.id,
      layerKind: layer.kind,
      field: { buffer, dtype, shape: field.shape },
      colormap: binding?.colormap ?? DEFAULT_COLORMAP,
      scale: binding?.scale ?? "linear",
      opacity: layer.opacity,
      ...(binding !== undefined ? { windowLevel: binding.window } : {}),
      ...kindParams,
    };
    worker.postMessage(request, [buffer]);
  };

  // Live per-layer color update — colormap + window/level + scale, no field transfer.
  const sendLayerColormap = (layer: Layer, binding: ColormapBinding): void => {
    if (layer.kind !== "slice" && layer.kind !== "volume") return;
    const request: RenderWorkerRequest = {
      kind: "setLayerColormap",
      requestId: LAYER_REQUEST_ID,
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
      requestId: LAYER_REQUEST_ID,
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
      requestId: LAYER_REQUEST_ID,
      order,
    };
    worker.postMessage(request);
  };

  // Upsert every layer drawing the active field (pre-M4: the one layer) from `computed`. A
  // transferred buffer detaches, so a (pre-M4 impossible) second same-field layer gets a copy.
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
  const unsubscribeComputed = store.subscribe(
    (state) => state.computed,
    (computed) => {
      if (!isReady() || computed === null) return;
      upsertActiveField(computed);
      sendComposite();
    },
  );

  // Structure channel — removals, the per-layer shading toggle, and the cheap composite. No upsert
  // here: a new layer's field data (and its initial `shaded`) ride the same-tick `computed` change
  // (M4's per-layer compute adds a real upsert path).
  const unsubscribeLayers = store.subscribe(
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
          requestId: LAYER_REQUEST_ID,
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
  // by reference and posts setLayerColormap for each layer whose binding object changed. Pre-M4 it's
  // the one layer, same cadence as the old global setWindowLevel; the upsert carries the binding for
  // a fresh layer, so this fires only on edits to an existing one.
  const unsubscribeBindings = store.subscribe(
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
    dispose() {
      unsubscribeComputed();
      unsubscribeLayers();
      unsubscribeBindings();
    },
  };
}
