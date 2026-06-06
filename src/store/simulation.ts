import { computableFields, computeField } from "@compute";
import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { ColormapBinding, ColormapId, ColorScale, WindowLevel } from "@schema/colormap.ts";
import type { FieldName, FloatArray } from "@schema/types.ts";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { type CameraPose, DEFAULT_POSE } from "./camera.ts";
import * as colormapOps from "./colormap.ts";
import type { Layer, LayerKind, LayerSpec } from "./layers.ts";
import * as layerOps from "./layers.ts";

export type { WindowLevel };

// The simulation store: holds the loaded dataset + active field, recomputes the derived field
// whenever either changes, and owns the instance-first `layers` registry. UI dispatches
// `setDataset`/`selectField`/layer intents; the app subscribes to `computed`/`layers` and forwards
// to the render worker (the store never touches `render` — the DAG forbids it).

const DEFAULT_FIELD: FieldName = "|B|";

// The kind of the single layer auto-seeded pre-M4 (no Layers UI yet). `volume` makes the M2.4a/4b
// camera visibly live on the synthetic field. The only change-point until M4 adds a kind toggle.
const DEFAULT_LAYER_KIND: LayerKind = "volume";

export type SimulationStatus = "empty" | "ready" | "error";

// Which clock produced a frame-timing sample — the diagnostics panel labels them distinctly so
// wall-clock (incl. JS/queue latency) never reads as the pure-GPU timestamp-query number. Restates
// render/frameTimer's FrameClock (the store can't import render — the DAG forbids it).
export type FrameClock = "timestamp" | "wallclock";

// Full finite extent of the active field — the slider track bounds.
export interface DataRange {
  readonly min: number;
  readonly max: number;
}

export interface SimulationState {
  readonly dataset: FieldDataset | null;
  readonly activeField: FieldName;
  // Recipes computable from the current dataset — the UI's field-selector options
  // (the UI can't reach `compute` directly, so the store derives them on load).
  readonly availableFields: readonly FieldName[];
  readonly computed: FieldArray | null;
  // The active field's finite extent — the slider track bounds (independent of any binding).
  readonly dataRange: DataRange | null;
  // The ColormapBinding registry (DESIGN §1010): the color-mapping layers reference by id, owning
  // colormap + window/level + scale. Layers share or split bindings; GC/merge wait for the M4 UI.
  readonly colormapBindings: Readonly<Record<string, ColormapBinding>>;
  // Orbit camera pose. Non-nullable — DEFAULT_POSE is always valid; the app streams it to the
  // render worker. M2.4b's pointer controls dispatch setCameraPose; the worker derives the camera.
  readonly cameraPose: CameraPose;
  // The instance-first scene: an ordered list of renderable layers (draw order = array order) and
  // the selected one. Pre-M4 the store auto-seeds exactly one layer for the active field.
  readonly layers: readonly Layer[];
  readonly selectedLayerId: string | null;
  readonly status: SimulationStatus;
  readonly error: string | null;
  // Render diagnostics (M2.8): the latest GPU frame time + its clock, and the panel's explicit
  // "Measure" toggle (drives the worker's continuous-repaint mode for sustained timing). `null`
  // until the first frame; the app forwards `frameTiming` worker replies via setFrameTiming.
  readonly frameTimeMs: number | null;
  readonly frameTimeClock: FrameClock | null;
  readonly isMeasuringContinuous: boolean;
  setDataset(dataset: FieldDataset): void;
  selectField(name: FieldName): void;
  setBindingColormap(id: string, colormap: ColormapId): void;
  setBindingWindow(id: string, center: number, width: number): void;
  setBindingScale(id: string, scale: ColorScale): void;
  setCameraPose(pose: CameraPose): void;
  addLayer(spec: LayerSpec): void;
  removeLayer(id: string): void;
  selectLayer(id: string | null): void;
  reorderLayer(id: string, toIndex: number): void;
  setLayerVisible(id: string, visible: boolean): void;
  setLayerOpacity(id: string, opacity: number): void;
  setFrameTiming(ms: number, clock: FrameClock): void;
  setMeasuringContinuous(on: boolean): void;
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
      // Per-store monotonic ids (reset with each store → deterministic, test-isolated).
      let layerIdSeq = 0;
      let bindingIdSeq = 0;
      const nextLayerId = (): string => `layer-${layerIdSeq++}`;
      const nextBindingId = (): string => `binding-${bindingIdSeq++}`;

      // Window when a field has no finite samples (all-NaN) — a unit window so the binding stays valid.
      const FALLBACK_WINDOW: WindowLevel = { center: 0, width: 1 };

      const recompute = (): void => {
        const { dataset, activeField } = get();
        if (dataset === null) {
          // Leave `layers`/`colormapBindings`/`selectedLayerId` untouched — a transient empty/error
          // state shouldn't tear down the layer + binding the field selector targets.
          set({ computed: null, status: "empty", error: null, dataRange: null });
          return;
        }
        try {
          const computed = computeField(activeField, dataset);
          // A fresh quantity has a fresh value scale — reset the bound window to its full range.
          const dataRange = finiteRange(computed.data);
          const window = dataRange ? fullRangeWindow(dataRange) : FALLBACK_WINDOW;
          const state = get();
          // Pre-M4 (no Layers UI): auto-seed one volume layer + its binding for the active field so
          // the field selector + colormap panel still drive the scene. Only when empty — re-selecting
          // a field or reloading must not spawn duplicates.
          const seed = state.layers.length === 0;
          let { layers, selectedLayerId, colormapBindings } = state;
          if (seed) {
            const bindingId = nextBindingId();
            colormapBindings = colormapOps.upsertBinding(
              colormapBindings,
              colormapOps.makeDefaultBinding(bindingId, activeField, window),
            );
            const layer = layerOps.makeDefaultLayer(nextLayerId(), activeField, DEFAULT_LAYER_KIND);
            layers = layerOps.addLayer(layers, { ...layer, colormapBindingId: bindingId });
            selectedLayerId = layers[0]?.id ?? null;
          } else {
            // Field switch: repoint the selected layer's binding at the new field + full range,
            // keeping its colormap + scale (the user's color choices outlive a field change).
            const bindingId =
              layers.find((layer) => layer.id === selectedLayerId)?.colormapBindingId ?? null;
            if (bindingId !== null)
              colormapBindings = colormapOps.retargetBinding(
                colormapBindings,
                bindingId,
                activeField,
                window,
              );
          }
          set({
            computed,
            status: "ready",
            error: null,
            dataRange,
            layers,
            selectedLayerId,
            colormapBindings,
          });
        } catch (err) {
          set({
            computed: null,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            dataRange: null,
          });
        }
      };

      return {
        dataset: null,
        activeField: DEFAULT_FIELD,
        availableFields: [],
        computed: null,
        dataRange: null,
        colormapBindings: {},
        cameraPose: DEFAULT_POSE,
        layers: [],
        selectedLayerId: null,
        status: "empty",
        error: null,
        frameTimeMs: null,
        frameTimeClock: null,
        isMeasuringContinuous: false,
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
        setBindingColormap(id, colormap) {
          const { colormapBindings } = get();
          const next = colormapOps.setBindingColormap(colormapBindings, id, colormap);
          if (next === colormapBindings) return; // missing id / unchanged → no fire
          set({ colormapBindings: next });
        },
        setBindingWindow(id, center, width) {
          const { colormapBindings } = get();
          const next = colormapOps.setBindingWindow(colormapBindings, id, center, width);
          if (next === colormapBindings) return;
          set({ colormapBindings: next });
        },
        setBindingScale(id, scale) {
          const { colormapBindings } = get();
          const next = colormapOps.setBindingScale(colormapBindings, id, scale);
          if (next === colormapBindings) return;
          set({ colormapBindings: next });
        },
        setCameraPose(pose) {
          set({ cameraPose: pose }); // fresh object each call so subscribeWithSelector fires
        },
        addLayer(spec) {
          // The spec is already a valid union member sans id; stamping the id reconstructs it.
          const id = nextLayerId();
          let { colormapBindings } = get();
          // Every renderable layer needs a binding — mint one for its field if the spec carries none.
          let bindingId = spec.colormapBindingId;
          if (bindingId === null) {
            bindingId = nextBindingId();
            const { dataRange } = get();
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
        removeLayer(id) {
          // Orphaned bindings are left in the registry — GC/merge wait for the M4 multi-layer UI.
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
        setFrameTiming(ms, clock) {
          const { frameTimeMs, frameTimeClock } = get();
          if (frameTimeMs === ms && frameTimeClock === clock) return; // identical sample → no fire
          set({ frameTimeMs: ms, frameTimeClock: clock });
        },
        setMeasuringContinuous(on) {
          if (get().isMeasuringContinuous === on) return;
          set({ isMeasuringContinuous: on });
        },
      };
    }),
  );
}
