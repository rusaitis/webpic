import type { FieldLine } from "@compute";
import type { FieldArray } from "@containers/field_dataset.ts";
import { REQUEST_IDS, type RenderWorkerRequest } from "@render/messages.ts";
import { type ColormapBinding, colormapColor, DEFAULT_COLORMAP } from "@schema/colormap.ts";
import type { Rgba01 } from "@schema/theme.ts";
import type { Vec3 } from "@schema/types.ts";
import { gridToWorld, type Layer, type SimulationStore, type UiStore } from "@store";
import { createStoreBridge } from "./storeBridge.ts";

// The loading pill raised while a layer upsert warms its GPU pipeline off the render path (the warm is
// async — compileAsync); the worker's layerCompiled ack drops it. A flat key (v0.1 draws one volume
// layer): a second upsert retitles the same pill, any layerCompiled drops it — like the streaming
// bridge's flat "open"/"step" keys.
const RENDER_PHASE_KEY = "render";

// Where on the layer's colormap the solid line color is sampled — high enough to read as a bright,
// saturated streamline over the volume. Color-by-scalar (the full colormap along the line) is M4.8.
const FIELDLINE_COLOR_T = 0.75;

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
  let lastTraces = store.getState().traces; // snapshot for the per-fieldlines-layer change diff

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

  // Live per-layer slice plane edit (slice-only) — only the changed field rides the wire. position is
  // a render-side uniform write (the drag hot path); axis rebuilds from the retained field. The store
  // SliceAxis ("x"|"y"|"z") is structurally the render SliceAxis, so it crosses verbatim.
  const sendSliceParams = (layer: Layer, axisChanged: boolean, positionChanged: boolean): void => {
    if (layer.kind !== "slice") return;
    const request: RenderWorkerRequest = {
      kind: "setSliceParams",
      requestId: REQUEST_IDS.layer,
      id: layer.id,
      ...(axisChanged ? { axis: layer.axis } : {}),
      ...(positionChanged ? { position: layer.position } : {}),
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

  // Pack a field-line layer's traced lines into the render box and post them as a batched
  // LineSegments2. The tracer integrates in physical-grid coords; `gridToWorld` (the exact inverse of
  // the seed pick's `worldToGrid`) maps each point into the same unit box the volume/slice/overlay
  // share. Both packed buffers are transferred (positions: flat world f32 xyz; counts: u32 per line).
  const sendUpsertFieldlines = (layer: Layer, lines: readonly FieldLine[]): void => {
    if (layer.kind !== "fieldlines") return;
    const grid = store.getState().dataset?.grid ?? null;
    const halfExtent = store.getState().worldHalfExtent;
    let total = 0;
    for (const line of lines) total += line.nPoints;
    const positions = new Float32Array(total * 3);
    const counts = new Uint32Array(lines.length);
    let w = 0;
    let i = 0;
    for (const line of lines) {
      counts[i++] = line.nPoints;
      const pts = line.points; // flat (N,3), physical f64
      for (let p = 0; p < line.nPoints; p++) {
        const phys: Vec3 = [pts[p * 3] ?? 0, pts[p * 3 + 1] ?? 0, pts[p * 3 + 2] ?? 0];
        const world = grid !== null ? gridToWorld(phys, grid, halfExtent) : phys;
        positions[w] = world[0];
        positions[w + 1] = world[1];
        positions[w + 2] = world[2];
        w += 3;
      }
    }
    const binding = bindingFor(layer);
    const rgb = colormapColor(binding?.colormap ?? DEFAULT_COLORMAP, FIELDLINE_COLOR_T);
    const color: Rgba01 = [rgb[0], rgb[1], rgb[2], 1];
    const request: RenderWorkerRequest = {
      kind: "upsertFieldlines",
      requestId: REQUEST_IDS.layer,
      id: layer.id,
      positions: positions.buffer as ArrayBuffer,
      counts: counts.buffer as ArrayBuffer,
      color,
      opacity: layer.opacity,
    };
    worker.postMessage(request, [positions.buffer, counts.buffer]);
    uiStore.getState().beginLoading(RENDER_PHASE_KEY, "preparing render");
  };

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
    const targets = layers.filter(
      (layer) => layer.field === activeField && (layer.kind === "slice" || layer.kind === "volume"),
    );
    targets.forEach((layer, index) => {
      const last = index === targets.length - 1;
      sendUpsert(layer, last ? computed : { ...computed, data: computed.data.slice() });
    });
  };

  const flushAll = (): void => {
    const { computed } = store.getState();
    if (computed !== null) upsertActiveField(computed);
    flushFieldlines();
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
      // Per-layer slice diff: a brand-new slice's axis/position rides the upsert, so fire only when an
      // existing slice layer's axis or position changed (position = the live drag hot path).
      for (const layer of layers) {
        if (layer.kind !== "slice") continue;
        const before = prevById.get(layer.id);
        if (before === undefined || before.kind !== "slice") continue; // new layer → rides the upsert
        const axisChanged = before.axis !== layer.axis;
        const positionChanged = before.position !== layer.position;
        if (axisChanged || positionChanged) sendSliceParams(layer, axisChanged, positionChanged);
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
