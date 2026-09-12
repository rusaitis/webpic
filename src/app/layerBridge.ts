import type { FieldArray } from "@containers/field_dataset.ts";
import { rejectionLogger } from "@schema/log.ts";
import { transferableBuffer } from "@schema/transfer.ts";
import {
  isFieldLayer,
  type Layer,
  PHASE_KEYS,
  type SimulationStore,
  selectComputed,
  type UiStore,
} from "@store";
import { createLayerUpserts } from "./layerUpserts.ts";
import { createStoreBridge, type RenderWorkerLink } from "./storeBridge.ts";

// The loading pill raised while a layer upsert warms its GPU pipeline off the render path (the warm is
// async — compileAsync); the worker's layerCompiled ack drops it. A flat key (today's scene draws one volume
// layer): a second upsert retitles the same pill, any layerCompiled drops it — like the streaming
// bridge's flat "open"/"step" keys.

// Bridges the store's instance-first layer registry to the render worker (app-only glue: store and
// render can't import each other). Two channels: `field` carries field DATA (heavy, transfers the
// buffer), `layers` carries STRUCTURE (removals + the cheap composite of order/visibility/opacity).
// The transfer detaches the store's buffer, so a layer added later gets its data by asking the store
// to recompute (recomputeField) — this bridge, the one that transferred, owns that call; per-layer
// compute will generalize it.

// `detached` — set by the transfer — is the honest "already handed over" check.
function isTransferred(field: FieldArray): boolean {
  return transferableBuffer(field.data).detached;
}

export interface LayerBridgeOptions extends RenderWorkerLink {
  readonly store: SimulationStore;
  // Raises/drops the render-loading pill across the upsert → layerCompiled round-trip.
  readonly uiStore: UiStore;
}

export interface LayerBridge {
  // Send the full current state (upsert each active-field layer + the composite). Catch-up on ready.
  readonly flushAll: () => void;
  // Drop the render-loading pill when the worker acks a layer's pipeline warm (the layerCompiled
  // response). Coalesced (flat key), so any acked layer clears the shared pill.
  readonly finishLoading: () => void;
  readonly dispose: () => void;
}

export function installLayerBridge(options: LayerBridgeOptions): LayerBridge {
  const { store, uiStore, worker, isReady } = options;
  const bridge = createStoreBridge(store, isReady);
  let lastLayers: readonly Layer[] = store.getState().layers; // snapshot for the removal diff
  let lastBindings = store.getState().colormapBindings; // snapshot for the per-binding change diff
  let lastTraces = store.getState().traces; // snapshot for the per-fieldlines-layer change diff
  let lastNotices = store.getState().traceNotices; // snapshot so one failure flashes once, not per retrace

  const {
    sendUpsert,
    sendLayerColormap,
    sendLayerShading,
    sendSliceParams,
    sendComposite,
    sendRemove,
    sendUpsertFieldlines,
    fieldUpserted,
  } = createLayerUpserts({ store, uiStore, worker });

  // Upsert every field-line layer that has traced lines (catch-up + structure-change replay).
  const flushFieldlines = (): void => {
    const { layers, traces } = store.getState();
    for (const layer of layers) {
      if (layer.kind !== "fieldlines") continue;
      const lines = traces[layer.id];
      if (lines !== undefined) sendUpsertFieldlines(layer, lines);
    }
  };

  // Upsert every layer drawing the active field from `computed`. Field lines reference the active
  // field for color, but draw traced lines (the traces channel), not the scalar texture — so only
  // slice/volume layers consume it. The transfer detaches `computed.data`, so copy (slice) for all
  // but the last *first* (while the buffer is live) and transfer the original to the last; transferring
  // first would leave the copies reading a detached buffer.
  const upsertActiveField = (computed: FieldArray): void => {
    const { layers, activeField } = store.getState();
    const targets = layers.filter((layer) => layer.field === activeField && isFieldLayer(layer));
    targets.forEach((layer, index) => {
      const last = index === targets.length - 1;
      sendUpsert(layer, last ? computed : { ...computed, data: computed.data.slice() });
    });
  };

  const flushAll = (): void => {
    const computed = selectComputed(store.getState());
    if (computed !== null) upsertActiveField(computed);
    flushFieldlines();
    sendComposite();
  };

  // Data channel — registered before the structure channel so the worker has a layer's scene
  // before any composite references it (a stray reference self-heals on the upsert repaint anyway).
  bridge.subscribe(
    (state) => state.field,
    (field) => {
      if (!isReady() || field.kind !== "ready") return;
      upsertActiveField(field.computed);
      sendComposite();
    },
  );

  // Structure channel — removals, a new layer's field data, the per-layer shading/slice edits, and
  // the cheap composite. The seed layer's data rides the same-tick `field` change (that channel is
  // registered first, so it has already upserted here); a layer added later needs its own supply.
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
        sendRemove(prev.id);
      }
      const prevById = new Map(prevLayers.map((layer) => [layer.id, layer]));
      // A new slice/volume layer on the active field that no upsert has fed yet: if the store's
      // buffer is still live (nothing transferred it — only field-line layers existed) upsert straight
      // from a copy; if it was transferred, ask the store to recompute — the `field` channel then
      // upserts every active-field layer, this one included.
      let needsRefill = false;
      for (const layer of layers) {
        if (prevById.has(layer.id) || fieldUpserted.has(layer.id)) continue;
        if (!isFieldLayer(layer)) continue;
        const { activeField } = store.getState();
        const computed = selectComputed(store.getState());
        if (computed === null || layer.field !== activeField) continue;
        if (isTransferred(computed)) needsRefill = true;
        else sendUpsert(layer, { ...computed, data: computed.data.slice() });
      }
      if (needsRefill) {
        void store.getState().recomputeField().catch(rejectionLogger("app", "field refill failed"));
      }
      // Per-layer Phong diff: a brand-new layer's `shaded` rides the upsert, so fire only when an
      // existing volume layer's flag flipped.
      for (const layer of layers) {
        if (layer.kind !== "volume") continue;
        const before = prevById.get(layer.id);
        if (before === undefined) continue; // new layer → its shaded rides the upsert
        if (before.kind === "volume" && before.shaded === layer.shaded) continue;
        sendLayerShading(layer);
      }
      // Per-layer slice diff: a brand-new slice's axis/position rides the upsert, so fire only when an
      // existing slice layer's axis or position changed (position = the live drag hot path).
      for (const layer of layers) {
        if (layer.kind !== "slice") continue;
        const before = prevById.get(layer.id);
        if (before === undefined || before.kind !== "slice") continue; // new layer → rides the upsert
        const axisChanged = before.axis !== layer.axis;
        const positionChanged = before.position !== layer.position;
        if (axisChanged || positionChanged)
          sendSliceParams(layer, { axis: axisChanged, position: positionChanged });
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

  // Traces channel — a fieldlines layer's traced lines (heavy, transfers the packed buffers). Fires
  // when retrace publishes fresh FieldLine[] (layer add, dataset switch). Diffed by reference per layer
  // id so an unrelated traces update can't re-pack an unchanged set.
  bridge.subscribe(
    (state) => state.traces,
    (traces) => {
      if (!isReady()) {
        lastTraces = traces; // keep the snapshot current so a later diff isn't spurious
        return;
      }
      for (const layer of store.getState().layers) {
        if (layer.kind !== "fieldlines") continue;
        const lines = traces[layer.id];
        if (lines === undefined || lastTraces[layer.id] === lines) continue;
        sendUpsertFieldlines(layer, lines);
      }
      lastTraces = traces;
    },
  );

  // Trace notices → status pill. A layer that traced *some* of its seeds explains itself in the
  // field-lines panel; one that traced none is the silent-empty case worth interrupting for (issue
  // #1). Unconditional (not `subscribeWhenReady`) — the message is about the trace, not the renderer.
  bridge.subscribe(
    (state) => state.traceNotices,
    (notices) => {
      for (const [id, notice] of Object.entries(notices)) {
        if (notice.requested === 0 || notice.traced > 0) continue;
        const previous = lastNotices[id];
        // Same layer, same empty outcome, same cause → already said; a different failure speaks up.
        if (
          previous?.traced === 0 &&
          previous.requested === notice.requested &&
          previous.error === notice.error
        )
          continue;
        uiStore.getState().flashError(notice.error ?? "field lines: no seed could be traced");
      }
      lastNotices = notices;
    },
  );

  return {
    flushAll,
    finishLoading() {
      uiStore.getState().endLoading(PHASE_KEYS.render);
    },
    dispose() {
      bridge.dispose();
    },
  };
}
