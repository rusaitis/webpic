import type { FieldArray } from "@containers/field_dataset.ts";
import type { RenderWorkerRequest } from "@render";
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

  const sendUpsert = (layer: Layer, field: FieldArray): void => {
    // Only slice/volume are renderable; fieldlines/particles (M4/M5) have no scene yet.
    if (layer.kind !== "slice" && layer.kind !== "volume") return;
    const dtype = field.data instanceof Float64Array ? "f64" : "f32";
    // Freshly computed magnitude → an offset-0 ArrayBuffer (not the SharedArrayBuffer that
    // ArrayBufferLike also admits), so it transfers wholesale.
    const buffer = field.data.buffer as ArrayBuffer;
    const { windowLevel } = store.getState();
    const kindParams =
      layer.kind === "slice"
        ? { axis: layer.axis, position: layer.position }
        : {
            ...(layer.steps !== null ? { steps: layer.steps } : {}),
            ...(layer.density !== null ? { density: layer.density } : {}),
          };
    const request: RenderWorkerRequest = {
      kind: "upsertLayer",
      requestId: LAYER_REQUEST_ID,
      id: layer.id,
      layerKind: layer.kind,
      field: { buffer, dtype, shape: field.shape },
      colormap: "inferno", // per-layer colormap arrives with M2.5b's ColormapBinding
      opacity: layer.opacity,
      ...(windowLevel !== null ? { windowLevel } : {}), // global window/level until M2.5b
      ...kindParams,
    };
    worker.postMessage(request, [buffer]);
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

  // Structure channel — removals + the cheap composite. No upsert here: a new layer's field data
  // rides the same-tick `computed` change (M4's per-layer compute adds a real upsert path).
  const unsubscribeLayers = store.subscribe(
    (state) => state.layers,
    (layers) => {
      if (!isReady()) {
        lastLayers = layers; // keep the snapshot current so a later diff isn't spurious
        return;
      }
      const liveIds = new Set(layers.map((layer) => layer.id));
      for (const prev of lastLayers) {
        if (liveIds.has(prev.id)) continue;
        const request: RenderWorkerRequest = {
          kind: "removeLayer",
          requestId: LAYER_REQUEST_ID,
          id: prev.id,
        };
        worker.postMessage(request);
      }
      lastLayers = layers;
      sendComposite();
    },
  );

  return {
    flushAll,
    dispose() {
      unsubscribeComputed();
      unsubscribeLayers();
    },
  };
}
