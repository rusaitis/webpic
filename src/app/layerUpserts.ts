import type { FieldLine } from "@compute";
import type { FieldArray } from "@containers/field_dataset.ts";
import { fieldPayload } from "@data";
import { type FieldLayerParams, REQUEST_IDS, type RenderWorkerRequest } from "@render/messages.ts";
import { type ColormapBinding, colormapColor, DEFAULT_COLORMAP } from "@schema/colormap.ts";
import type { Rgba01 } from "@schema/theme.ts";
import { transferableBuffer } from "@schema/transfer.ts";
import type { Vec3 } from "@schema/types.ts";
import {
  type FieldLayer,
  gridToWorld,
  isFieldLayer,
  type Layer,
  PHASE_KEYS,
  type SimulationStore,
  type UiStore,
} from "@store";
import type { RenderWorkerLink } from "./storeBridge.ts";

// Every store layer → render-worker message, in one place: what each wire request carries and when a
// field transfer is involved. installLayerBridge owns *when* to send; this owns *what* is sent, so the
// diff logic up there reads as intent rather than as message construction.
//
// The loading pill is raised here because it is raised by exactly the two messages that make the
// worker compile a pipeline (the field upserts) — the ack that drops it lands in layerBridge.

// Color sampled from the layer's colormap for its field lines — a saturated streamline over the volume.
const FIELDLINE_COLOR_T = 0.75;

// The pill key both field upserts share; a second upsert retitles the same pill and any layerCompiled
// drops it.

// The wire's per-kind build params from a store layer. `worldHalfExtent` is the dataset's volume-box
// aspect — the worker scales the mesh to it (cubic → unit cube); slices ignore it.
function upsertParams(layer: FieldLayer, worldHalfExtent: Vec3): FieldLayerParams {
  switch (layer.kind) {
    case "slice":
      return { layerKind: "slice", axis: layer.axis, position: layer.position };
    case "volume":
      return {
        layerKind: "volume",
        shaded: layer.shaded,
        worldHalfExtent,
        ...(layer.steps !== null ? { steps: layer.steps } : {}),
        ...(layer.density !== null ? { density: layer.density } : {}),
      };
  }
}

export interface LayerUpsertsOptions extends Pick<RenderWorkerLink, "worker"> {
  readonly store: SimulationStore;
  readonly uiStore: UiStore;
}

// Which of a slice's two params moved. Named rather than two positional booleans: at the call site
// `(layer, false, true)` says nothing, and the two are swappable without a type error.
interface SliceChange {
  readonly axis: boolean;
  readonly position: boolean;
}

export interface LayerUpserts {
  // Post a field layer's scalar. The buffer is TRANSFERRED — the caller must not read it after.
  sendUpsert(layer: Layer, field: FieldArray): void;
  sendLayerColormap(layer: Layer, binding: ColormapBinding): void;
  sendLayerShading(layer: Layer): void;
  sendSliceParams(layer: Layer, changed: SliceChange): void;
  sendComposite(): void;
  sendRemove(id: string): void;
  sendUpsertFieldlines(layer: Layer, lines: readonly FieldLine[]): void;
  // Layers whose scene has received field data — the diff uses it to spot a layer still waiting.
  readonly fieldUpserted: Set<string>;
}

export function createLayerUpserts(options: LayerUpsertsOptions): LayerUpserts {
  const { store, uiStore, worker } = options;
  const fieldUpserted = new Set<string>();

  // The layer's ColormapBinding, or undefined if it references none (defensive — every renderable
  // layer is seeded with one).
  const bindingFor = (layer: Layer): ColormapBinding | undefined =>
    layer.colormapBindingId !== null
      ? store.getState().colormapBindings[layer.colormapBindingId]
      : undefined;

  const sendUpsert = (layer: Layer, field: FieldArray): void => {
    if (!isFieldLayer(layer)) return; // field lines draw traced polylines, not the scalar texture
    const payload = fieldPayload(field); // freshly computed, offset-0 → transfers wholesale
    const binding = bindingFor(layer);
    const request: RenderWorkerRequest = {
      kind: "upsertLayer",
      requestId: REQUEST_IDS.layer,
      id: layer.id,
      field: payload,
      colormap: binding?.colormap ?? DEFAULT_COLORMAP,
      scale: binding?.scale ?? "linear",
      opacity: layer.opacity,
      ...(binding !== undefined ? { windowLevel: binding.window } : {}),
      params: upsertParams(layer, store.getState().worldHalfExtent),
    };
    worker.postMessage(request, [payload.buffer]);
    fieldUpserted.add(layer.id);
    // The warm (compileAsync) runs off the render path; hold a pill until the worker acks layerCompiled.
    uiStore.getState().beginLoading(PHASE_KEYS.render, "preparing render");
  };

  // Live per-layer color update — colormap + window/level + scale, no field transfer.
  const sendLayerColormap = (layer: Layer, binding: ColormapBinding): void => {
    if (!isFieldLayer(layer)) return;
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
  const sendSliceParams = (layer: Layer, changed: SliceChange): void => {
    if (layer.kind !== "slice") return;
    const request: RenderWorkerRequest = {
      kind: "setSliceParams",
      requestId: REQUEST_IDS.layer,
      id: layer.id,
      ...(changed.axis ? { axis: layer.axis } : {}),
      ...(changed.position ? { position: layer.position } : {}),
    };
    worker.postMessage(request);
  };

  const sendRemove = (id: string): void => {
    fieldUpserted.delete(id);
    const request: RenderWorkerRequest = { kind: "removeLayer", requestId: REQUEST_IDS.layer, id };
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
      positions: transferableBuffer(positions),
      counts: transferableBuffer(counts),
      color,
      opacity: layer.opacity,
    };
    worker.postMessage(request, [positions.buffer, counts.buffer]);
    uiStore.getState().beginLoading(PHASE_KEYS.render, "preparing render");
  };

  return {
    sendUpsert,
    sendLayerColormap,
    sendLayerShading,
    sendSliceParams,
    sendComposite,
    sendRemove,
    sendUpsertFieldlines,
    fieldUpserted,
  };
}
