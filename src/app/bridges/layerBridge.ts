import type { FieldArray } from "@containers/field_dataset.ts";
import { rejectionLogger } from "@schema/log.ts";
import { transferableBuffer } from "@schema/transfer.ts";
import {
  type FieldLayer,
  isFieldLayer,
  isTracingLayer,
  type Layer,
  PHASE_KEYS,
  type SimulationStore,
  selectComputed,
  type TraceNotice,
  type UiStore,
} from "@store";
import { createStoreBridge, type RenderWorkerLink } from "./_storeBridge.ts";
import { createLayerMessages, type LayerMessages } from "./layerMessages.ts";

// Bridges the store's instance-first layer registry to the render worker (app-only glue: store and
// render can't import each other). Two channels: `field` carries field DATA (heavy, transfers the
// buffer), `layers` carries STRUCTURE (removals + the cheap layer order of visibility/opacity). The
// transfer detaches the store's buffer, so a layer added later gets its data by asking the store to
// recompute — this bridge, the one that transferred, owns that call. The render loading pill is
// flat-keyed: a second upsert retitles it, and any layerCompiled ack drops it.

// `detached` — set by the transfer — is the honest "already handed over" check.
function isTransferred(field: FieldArray): boolean {
  return transferableBuffer(field.data).detached;
}

// Layers gone from the registry — the worker drops their scenes.
function sendRemovals(
  next: readonly Layer[],
  previous: readonly Layer[],
  send: LayerMessages,
): void {
  const liveIds = new Set(next.map((layer) => layer.id));
  for (const layer of previous) {
    if (!liveIds.has(layer.id)) send.remove(layer.id);
  }
}

// A new slice/volume layer on the active field that no upsert has fed yet: if the store's buffer is
// still live (nothing transferred it — only field-line layers existed) upsert straight from a copy.
// Returns whether one was left unfed because the buffer had already gone, which only a recompute can
// refill — the `field` channel then upserts every active-field layer, that one included.
function refillNewFieldLayers(
  next: readonly Layer[],
  previousById: ReadonlyMap<string, Layer>,
  store: SimulationStore,
  send: LayerMessages,
): boolean {
  const { activeField } = store.getState();
  const computed = selectComputed(store.getState());
  if (computed === null) return false;
  let needsRefill = false;
  for (const layer of next) {
    if (previousById.has(layer.id) || send.fieldUpserted.has(layer.id)) continue;
    if (!isFieldLayer(layer) || layer.field !== activeField) continue;
    if (isTransferred(computed)) needsRefill = true;
    else send.upsert(layer, { ...computed, data: computed.data.slice() });
  }
  return needsRefill;
}

// Per-layer param edits. A brand-new layer's params ride its upsert, so only a layer that existed in
// the previous list reaches a send. The switch is the compile gate: a new LayerKind must say here
// which of its params are live-editable before it can draw.
function sendLayerEdits(
  next: readonly Layer[],
  previousById: ReadonlyMap<string, Layer>,
  send: LayerMessages,
): void {
  for (const layer of next) {
    const before = previousById.get(layer.id);
    if (before === undefined) continue;
    switch (layer.kind) {
      case "volume":
        if (before.kind === "volume" && before.shaded !== layer.shaded) send.layerShading(layer);
        break;
      case "slice": {
        if (before.kind !== "slice") break;
        const hasAxisChanged = before.axis !== layer.axis;
        // The live drag hot path; only the moved param rides the wire.
        const hasPositionChanged = before.position !== layer.position;
        if (hasAxisChanged || hasPositionChanged)
          send.sliceParams(layer, { hasAxisChanged, hasPositionChanged });
        break;
      }
      case "fieldlines":
        break; // seeds publish through retrace — the traces channel sends the lines
      default:
        layer satisfies never; // no runtime arrival path — the store's union is the only source
        break;
    }
  }
}

// Upsert every field-line layer that has traced lines (catch-up + structure-change replay).
function flushFieldlines(store: SimulationStore, send: LayerMessages): void {
  const { layers, traces } = store.getState();
  for (const layer of layers) {
    if (!isTracingLayer(layer)) continue;
    const lines = traces[layer.id];
    if (lines !== undefined) send.upsertFieldlines(layer, lines);
  }
}

// Upsert every layer drawing the active field from `computed`. Field lines reference the active field
// for color, but draw traced lines (the traces channel), not the scalar texture — so only slice/volume
// layers consume it. The transfer detaches `computed.data`, so copy (slice) for all but the last
// *first* (while the buffer is live) and transfer the original to the last; transferring first would
// leave the copies reading a detached buffer.
function upsertActiveField(
  store: SimulationStore,
  send: LayerMessages,
  computed: FieldArray,
): void {
  const { layers, activeField } = store.getState();
  const targets: FieldLayer[] = [];
  for (const layer of layers) {
    if (layer.field === activeField && isFieldLayer(layer)) targets.push(layer);
  }
  targets.forEach((layer, index) => {
    const last = index === targets.length - 1;
    send.upsert(layer, last ? computed : { ...computed, data: computed.data.slice() });
  });
}

// Same layer, same empty outcome, same cause → already said; a different failure speaks up.
function isRepeatNotice(notice: TraceNotice, before: TraceNotice | undefined): boolean {
  return (
    before?.traced === 0 && before.requested === notice.requested && before.error === notice.error
  );
}

export interface LayerBridgeOptions extends RenderWorkerLink {
  readonly store: SimulationStore;
  // Raises/drops the render-loading pill across the upsert → layerCompiled round-trip.
  readonly uiStore: UiStore;
}

export interface LayerBridge {
  // Send the full current state (upsert each active-field layer + the order). Catch-up on ready.
  readonly flushAll: () => void;
  // Drop the render-loading pill when the worker acks a layer's pipeline warm (the layerCompiled
  // response). Coalesced (flat key), so any acked layer clears the shared pill.
  readonly finishLoading: () => void;
  readonly dispose: () => void;
}

export function installLayerBridge(options: LayerBridgeOptions): LayerBridge {
  const { store, uiStore, worker, isReady } = options;
  const bridge = createStoreBridge(store, isReady);
  const send = createLayerMessages({ store, uiStore, worker });

  const flushAll = (): void => {
    const computed = selectComputed(store.getState());
    if (computed !== null) upsertActiveField(store, send, computed);
    flushFieldlines(store, send);
    send.composite();
  };

  // Data channel — registered before the structure channel so the worker has a layer's scene
  // before any order entry references it (a stray reference self-heals on the upsert repaint anyway).
  bridge.subscribe(
    (state) => state.field,
    (field) => {
      if (!isReady() || field.kind !== "ready") return;
      upsertActiveField(store, send, field.computed);
      send.composite();
    },
  );

  // Structure channel — removals, a new layer's field data, the per-layer shading/slice edits, and
  // the cheap order. The seed layer's data rides the same-tick `field` change (that channel is
  // registered first, so it has already upserted here); a layer added later needs its own supply.
  bridge.subscribeDiff(
    (state) => state.layers,
    (layers, previous) => {
      if (!isReady()) return;
      sendRemovals(layers, previous, send);
      const previousById = new Map(previous.map((layer) => [layer.id, layer]));
      if (refillNewFieldLayers(layers, previousById, store, send)) {
        void store.getState().recomputeField().catch(rejectionLogger("app", "field refill failed"));
      }
      sendLayerEdits(layers, previousById, send);
      send.composite();
    },
  );

  // Bindings channel — the live color hot path (colormap / window-drag / scale). Diffs the registry
  // by reference and posts setLayerColormap for each layer whose binding object changed. The upsert
  // carries the binding for a fresh layer, so this fires only on edits to an existing one.
  bridge.subscribeDiff(
    (state) => state.colormapBindings,
    (bindings, previous) => {
      if (!isReady()) return;
      for (const layer of store.getState().layers) {
        if (layer.colormapBindingId === null || !isFieldLayer(layer)) continue;
        const binding = bindings[layer.colormapBindingId];
        const before = previous[layer.colormapBindingId];
        // Skip a brand-new binding — its color rides the same-tick upsert (seed/field switch).
        if (binding === undefined || before === undefined || binding === before) continue;
        send.layerColormap(layer, binding);
      }
    },
  );

  // Traces channel — a fieldlines layer's traced lines (heavy, transfers the packed buffers). Fires
  // when retrace publishes fresh FieldLine[] (layer add, dataset switch). Diffed by reference per layer
  // id so an unrelated traces update can't re-pack an unchanged set.
  bridge.subscribeDiff(
    (state) => state.traces,
    (traces, previous) => {
      if (!isReady()) return;
      for (const layer of store.getState().layers) {
        if (!isTracingLayer(layer)) continue;
        const lines = traces[layer.id];
        if (lines === undefined || previous[layer.id] === lines) continue;
        send.upsertFieldlines(layer, lines);
      }
    },
  );

  // Trace notices → status pill. A layer that traced *some* of its seeds explains itself in the
  // field-lines panel; one that traced none is the silent-empty case worth interrupting for (issue
  // #1). Unconditional (not gated on isReady) — the message is about the trace, not the renderer.
  bridge.subscribeDiff(
    (state) => state.traceNotices,
    (notices, previous) => {
      for (const [id, notice] of Object.entries(notices)) {
        if (notice.requested === 0 || notice.traced > 0) continue;
        if (isRepeatNotice(notice, previous[id])) continue;
        uiStore.getState().flashError(notice.error ?? "field lines: no seed could be traced");
      }
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
