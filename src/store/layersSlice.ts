import { fullRangeWindow } from "@schema/colormap.ts";
import * as colormapOps from "./colormap.ts";
import { FALLBACK_WINDOW } from "./fieldCompute.ts";
import type { Retrace } from "./fieldTrace.ts";
import { LAYER_KINDS } from "./layerKinds.ts";
import type { Layer } from "./layers.ts";
import * as layerOps from "./layers.ts";
import { defaultSeedRake } from "./seedPick.ts";
import { selectDataRange } from "./selectors.ts";
import type { LayersSlice, SceneIds, SliceContext } from "./state.ts";

// The instance-first scene: the ordered layer list, the selection, and the field-line traces.

export interface LayersSliceHost extends SliceContext {
  readonly ids: SceneIds;
  readonly retrace: Retrace;
}

// Drop one key from a per-layer record (traces / notices), leaving the original untouched.
function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [k, value] of Object.entries(record)) if (k !== key) next[k] = value;
  return next;
}

export function createLayersSlice({ get, set, ids, retrace }: LayersSliceHost): LayersSlice {
  // The list setters share one shape: run a pure op and commit only a real change — an unchanged
  // result must NOT fire subscribeWithSelector (it would spuriously re-render).
  const updateLayers = (op: (layers: readonly Layer[]) => readonly Layer[]): void => {
    const { layers } = get();
    const next = op(layers);
    if (next !== layers) set({ layers: next });
  };

  return {
    layers: [],
    selectedLayerId: null,
    traces: {},
    traceNotices: {},
    seedPlacementLayerId: null,
    addLayer(spec) {
      // The spec is already a valid union member sans id; stamping the id reconstructs it.
      const id = ids.nextLayerId();
      let { colormapBindings } = get();
      // Every renderable layer needs a binding — mint one for its field if the spec carries none.
      let bindingId = spec.colormapBindingId;
      if (bindingId === null) {
        bindingId = ids.nextBindingId();
        const dataRange = selectDataRange(get());
        const window = dataRange ? fullRangeWindow(dataRange) : FALLBACK_WINDOW;
        colormapBindings = colormapOps.upsertBinding(
          colormapBindings,
          colormapOps.makeDefaultBinding(bindingId, spec.field, window),
        );
      }
      const layer = { ...spec, id, colormapBindingId: bindingId } as Layer;
      set({
        layers: layerOps.addLayer(get().layers, layer),
        selectedLayerId: layer.id,
        colormapBindings,
      });
    },
    addLayerOfKind(kind) {
      const { dataset, activeField } = get();
      if (dataset === null) return; // nothing to draw, seed, or trace yet
      const descriptor = LAYER_KINDS[kind];
      // addLayer mints the id + a ColormapBinding; a traced kind then traces its rake.
      get().addLayer(descriptor.makeDefaultSpec(activeField, dataset.grid));
      if (descriptor.tracesLines) void retrace(); // total (owns its abort + generation guard)
    },
    addFieldlinesLayer() {
      get().addLayerOfKind("fieldlines");
    },
    removeLayer(id) {
      // Orphaned bindings are left in the registry — GC/merge wait for the multi-layer UI.
      const { layers, selectedLayerId, seedPlacementLayerId, traces, traceNotices } = get();
      const next = layerOps.removeLayer(layers, id);
      if (next === layers) return; // absent id → no-op
      const selected = selectedLayerId === id ? (next[0]?.id ?? null) : selectedLayerId;
      set({
        layers: next,
        ...(Object.hasOwn(traces, id) ? { traces: omitKey(traces, id) } : {}),
        ...(Object.hasOwn(traceNotices, id) ? { traceNotices: omitKey(traceNotices, id) } : {}),
        ...(selected !== selectedLayerId ? { selectedLayerId: selected } : {}),
        // Don't strand seed-placement on a removed layer (the canvas would stay in crosshair mode).
        ...(seedPlacementLayerId === id ? { seedPlacementLayerId: null } : {}),
      });
    },
    selectLayer(id) {
      if (id === get().selectedLayerId) return;
      set({ selectedLayerId: id });
    },
    reorderLayer(id, toIndex) {
      updateLayers((l) => layerOps.reorderLayer(l, id, toIndex));
    },
    setLayerVisible(id, visible) {
      updateLayers((l) => layerOps.setLayerVisible(l, id, visible));
    },
    setLayerOpacity(id, opacity) {
      updateLayers((l) => layerOps.setLayerOpacity(l, id, opacity));
    },
    setLayerShading(id, shaded) {
      updateLayers((l) => layerOps.setLayerShading(l, id, shaded));
    },
    setSliceAxis(id, axis) {
      updateLayers((l) => layerOps.setSliceAxis(l, id, axis));
    },
    setSlicePosition(id, position) {
      updateLayers((l) => layerOps.setSlicePosition(l, id, position));
    },
    setFieldlineSeeds(id, seeds) {
      const { layers } = get();
      const next = layerOps.setFieldlineSeeds(layers, id, seeds);
      if (next === layers) return; // missing id / non-fieldlines / same ref → no retrace
      set({ layers: next });
      void retrace(); // total (owns its abort + generation guard), never rejects
    },
    setFieldlineSeedCount(id, count) {
      const { dataset } = get();
      if (dataset === null) return; // no grid to rake over yet
      get().setFieldlineSeeds(id, defaultSeedRake(dataset.grid, count));
    },
    addFieldlineSeed(id, seed) {
      const layer = get().layers.find((l) => l.id === id);
      if (layer === undefined || layer.kind !== "fieldlines") return;
      get().setFieldlineSeeds(id, [...layer.seeds, seed]);
    },
    setSeedPlacement(id) {
      if (id === get().seedPlacementLayerId) return; // unchanged → no fire
      set({ seedPlacementLayerId: id });
    },
  };
}
