import { computableFields, computeField } from "@compute";
import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { FieldName, FloatArray } from "@schema/types.ts";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { type CameraPose, DEFAULT_POSE } from "./camera.ts";
import type { Layer, LayerKind, LayerSpec } from "./layers.ts";
import * as layerOps from "./layers.ts";

// The simulation store: holds the loaded dataset + active field, recomputes the derived field
// whenever either changes, and owns the instance-first `layers` registry. UI dispatches
// `setDataset`/`selectField`/layer intents; the app subscribes to `computed`/`layers` and forwards
// to the render worker (the store never touches `render` — the DAG forbids it).

const DEFAULT_FIELD: FieldName = "|B|";

// The kind of the single layer auto-seeded pre-M4 (no Layers UI yet). `volume` makes the M2.4a/4b
// camera visibly live on the synthetic field. The only change-point until M4 adds a kind toggle.
const DEFAULT_LAYER_KIND: LayerKind = "volume";

export type SimulationStatus = "empty" | "ready" | "error";

// Full finite extent of the active field — the slider track bounds.
export interface DataRange {
  readonly min: number;
  readonly max: number;
}

// Value→color window in the canonical {center, width} form (no separate min/max). Restated, not
// shared, with the render-side WindowLevel (messages.ts / normalization.ts): the ui→store→render
// DAG forbids store importing render. The M2.4 ColormapBinding reifies this per field.
export interface WindowLevel {
  readonly center: number;
  readonly width: number;
}

export interface SimulationState {
  readonly dataset: FieldDataset | null;
  readonly activeField: FieldName;
  // Recipes computable from the current dataset — the UI's field-selector options
  // (the UI can't reach `compute` directly, so the store derives them on load).
  readonly availableFields: readonly FieldName[];
  readonly computed: FieldArray | null;
  // The active field's finite extent (slider bounds) and the current value→color window.
  readonly dataRange: DataRange | null;
  readonly windowLevel: WindowLevel | null;
  // Orbit camera pose. Non-nullable — DEFAULT_POSE is always valid; the app streams it to the
  // render worker. M2.4b's pointer controls dispatch setCameraPose; the worker derives the camera.
  readonly cameraPose: CameraPose;
  // The instance-first scene: an ordered list of renderable layers (draw order = array order) and
  // the selected one. Pre-M4 the store auto-seeds exactly one layer for the active field.
  readonly layers: readonly Layer[];
  readonly selectedLayerId: string | null;
  readonly status: SimulationStatus;
  readonly error: string | null;
  setDataset(dataset: FieldDataset): void;
  selectField(name: FieldName): void;
  setWindowLevel(center: number, width: number): void;
  setCameraPose(pose: CameraPose): void;
  addLayer(spec: LayerSpec): void;
  removeLayer(id: string): void;
  selectLayer(id: string | null): void;
  reorderLayer(id: string, toIndex: number): void;
  setLayerVisible(id: string, visible: boolean): void;
  setLayerOpacity(id: string, opacity: number): void;
}

// Finite-only min/max in one pass (mirrors volumeTexture.ts; the store can't import `render`,
// and `reductions` isn't in store's allowed imports). A constant field is widened by 1 so the
// default window has a finite width; no finite samples → null.
function finiteRange(data: FloatArray): DataRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return null;
  if (min === max) return { min, max: max + 1 };
  return { min, max };
}

function fullRangeWindow(range: DataRange): WindowLevel {
  return { center: (range.min + range.max) / 2, width: range.max - range.min };
}

// Inferred from the factory so the `subscribeWithSelector` overload (selector + listener)
// survives — a plain StoreApi<SimulationState> annotation would erase it.
export type SimulationStore = ReturnType<typeof createSimulationStore>;

export function createSimulationStore() {
  return createStore<SimulationState>()(
    subscribeWithSelector((set, get) => {
      // Per-store monotonic id (resets with each store → deterministic, test-isolated).
      let layerIdSeq = 0;
      const nextLayerId = (): string => `layer-${layerIdSeq++}`;

      const recompute = (): void => {
        const { dataset, activeField } = get();
        if (dataset === null) {
          // Leave `layers`/`selectedLayerId` untouched — a transient empty/error state shouldn't
          // tear down the layer the field selector targets.
          set({ computed: null, status: "empty", error: null, dataRange: null, windowLevel: null });
          return;
        }
        try {
          const computed = computeField(activeField, dataset);
          // Reset the window to the new field's full range — a fresh quantity has a fresh
          // value scale. M2.5b's ColormapBinding will persist per-field windows instead.
          const dataRange = finiteRange(computed.data);
          const windowLevel = dataRange ? fullRangeWindow(dataRange) : null;
          // Pre-M4 (no Layers UI): auto-seed one layer for the active field so the field selector +
          // window/level panel still drive the scene. Only when empty — re-selecting a field or
          // reloading must not spawn duplicates.
          const seed = get().layers.length === 0;
          const layers = seed
            ? layerOps.addLayer(
                get().layers,
                layerOps.makeDefaultLayer(nextLayerId(), activeField, DEFAULT_LAYER_KIND),
              )
            : get().layers;
          const selectedLayerId = seed ? (layers[0]?.id ?? null) : get().selectedLayerId;
          set({
            computed,
            status: "ready",
            error: null,
            dataRange,
            windowLevel,
            layers,
            selectedLayerId,
          });
        } catch (err) {
          set({
            computed: null,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            dataRange: null,
            windowLevel: null,
          });
        }
      };

      return {
        dataset: null,
        activeField: DEFAULT_FIELD,
        availableFields: [],
        computed: null,
        dataRange: null,
        windowLevel: null,
        cameraPose: DEFAULT_POSE,
        layers: [],
        selectedLayerId: null,
        status: "empty",
        error: null,
        setDataset(dataset) {
          set({ dataset, availableFields: computableFields(dataset) });
          recompute();
        },
        selectField(name) {
          if (name === get().activeField) return; // recompute yields a fresh array — skip the no-op re-render
          // Pre-M4 the one layer follows the field selector — re-point it so its `field` stays
          // honest (the spread preserves the union member's kind-specific keys).
          const { selectedLayerId, layers } = get();
          const repointed =
            selectedLayerId !== null
              ? layers.map((layer) =>
                  layer.id === selectedLayerId ? { ...layer, field: name } : layer,
                )
              : layers;
          set({ activeField: name, ...(repointed !== layers ? { layers: repointed } : {}) });
          recompute();
        },
        setWindowLevel(center, width) {
          set({ windowLevel: { center, width } });
        },
        setCameraPose(pose) {
          set({ cameraPose: pose }); // fresh object each call so subscribeWithSelector fires
        },
        addLayer(spec) {
          // The spec is already a valid union member sans id; stamping the id reconstructs it.
          const layer = { ...spec, id: nextLayerId() } as Layer;
          set({ layers: layerOps.addLayer(get().layers, layer), selectedLayerId: layer.id });
        },
        removeLayer(id) {
          const { layers, selectedLayerId } = get();
          const next = layerOps.removeLayer(layers, id);
          if (next === layers) return; // absent id → no-op
          const selected = selectedLayerId === id ? (next[0]?.id ?? null) : selectedLayerId;
          set({
            layers: next,
            ...(selected !== selectedLayerId ? { selectedLayerId: selected } : {}),
          });
        },
        selectLayer(id) {
          if (id === get().selectedLayerId) return;
          set({ selectedLayerId: id });
        },
        reorderLayer(id, toIndex) {
          const { layers } = get();
          const next = layerOps.reorderLayer(layers, id, toIndex);
          if (next === layers) return;
          set({ layers: next });
        },
        setLayerVisible(id, visible) {
          const { layers } = get();
          const next = layerOps.setLayerVisible(layers, id, visible);
          if (next === layers) return;
          set({ layers: next });
        },
        setLayerOpacity(id, opacity) {
          const { layers } = get();
          const next = layerOps.setLayerOpacity(layers, id, opacity);
          if (next === layers) return;
          set({ layers: next });
        },
      };
    }),
  );
}
