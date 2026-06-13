import { computableFields, computeField } from "@compute";
import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import type { ColormapBinding, ColormapId, ColorScale, WindowLevel } from "@schema/colormap.ts";
import { DEFAULT_DATASET_ID } from "@schema/datasets.ts";
import type { MarkerPart, PickPurpose } from "@schema/marker.ts";
import type { FieldName, FloatArray, Vec3 } from "@schema/types.ts";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import {
  type CameraFlyTarget,
  type CameraMotion,
  type CameraPose,
  type CameraProjection,
  DEFAULT_POSE,
} from "./camera.ts";
import * as colormapOps from "./colormap.ts";
import type { Layer, LayerKind, LayerSpec } from "./layers.ts";
import * as layerOps from "./layers.ts";
import * as overlayOps from "./overlay.ts";
import { DEFAULT_OVERLAY, type GridPlane, type OverlayState } from "./overlay.ts";

export type { WindowLevel };

// The simulation store: holds the loaded dataset + active field, recomputes the derived field
// whenever either changes, and owns the instance-first `layers` registry. UI dispatches
// `setDataset`/`selectField`/layer intents; the app subscribes to `computed`/`layers` and forwards
// to the render worker (the store never touches `render` — the DAG forbids it).

const DEFAULT_FIELD: FieldName = "|B|";

// The kind of the single auto-seeded layer (no Layers UI yet). `volume` makes the camera visibly
// live on the synthetic field; the only change-point until a kind toggle lands.
const DEFAULT_LAYER_KIND: LayerKind = "volume";

export type SimulationStatus = "empty" | "ready" | "error";

// Which clock produced a frame-timing sample — the diagnostics panel labels them distinctly so
// wall-clock (incl. JS/queue latency) never reads as the pure-GPU timestamp-query number. Restates
// render/frameTimer's FrameClock (store can't import render).
export type FrameClock = "timestamp" | "wallclock";

// Full finite extent of the active field — the slider track bounds.
export interface DataRange {
  readonly min: number;
  readonly max: number;
}

const UNIT_HALF_EXTENT: Vec3 = [0.5, 0.5, 0.5];

// Per-axis world half-extent for a grid: physical spans normalized so the longest axis is 0.5 (the
// unit box). Cubic grids → [0.5, 0.5, 0.5] (identity, byte-for-byte the old behavior); non-cubic ones
// drive the volume box aspect — the renderer scales the mesh to it, the overlay maps onto it, the
// picker clamps to it. Mirrors sceneSync's span (spacing×dim, voxel-index fallback when spacing is
// unusable) so the overlay axis bounds and this box agree.
export function worldHalfExtentForGrid(grid: GridInfo): Vec3 {
  const span = (i: number): number => {
    const dim = grid.dimensions[i] ?? 1;
    const spacing = grid.spacing[i];
    return spacing !== undefined && Number.isFinite(spacing) && spacing > 0 ? spacing * dim : dim;
  };
  const sx = span(0);
  const sy = span(1);
  const sz = span(2);
  const max = Math.max(sx, sy, sz) || 1;
  return [(0.5 * sx) / max, (0.5 * sy) / max, (0.5 * sz) / max];
}

export interface SimulationState {
  readonly dataset: FieldDataset | null;
  // Which built-in dataset is selected (schema `DATASET_CATALOG` id). A UI signal the app reacts to:
  // selectDataset records it, the app rebuilds the dataset + re-opens the stream (the store can't reach
  // `data`/`app`). Mirrors how `projection`/`currentStep` are store-owned but app-forwarded.
  readonly datasetId: string;
  // Per-axis world half-extent of the volume box, derived from the active dataset's grid. [0.5,0.5,0.5]
  // for a cubic dataset (the unit box); anisotropic for a non-cubic one (true physical aspect). The app
  // forwards it to the render worker (volume mesh scale + overlay) and store-side picking clamps to it.
  readonly worldHalfExtent: Vec3;
  readonly activeField: FieldName;
  // Recipes computable from the current dataset — the UI's field-selector options
  // (the UI can't reach `compute` directly, so the store derives them on load).
  readonly availableFields: readonly FieldName[];
  readonly computed: FieldArray | null;
  // The active field's finite extent — the slider track bounds (independent of any binding).
  readonly dataRange: DataRange | null;
  // The ColormapBinding registry (DESIGN §1010): the color-mapping layers reference by id, owning
  // colormap + window/level + scale. Layers share or split bindings; GC/merge wait for the multi-layer UI.
  readonly colormapBindings: Readonly<Record<string, ColormapBinding>>;
  // Orbit camera pose. Non-nullable — DEFAULT_POSE is always valid; the app streams it to the
  // render worker. The pointer controls dispatch setCameraPose; the worker derives the camera.
  readonly cameraPose: CameraPose;
  // Camera-motion liveness: "gesture" while the hand is on the camera (drag, glide, held key,
  // wheel trail), "fly" while only a machine-driven eased flight runs. The app forwards it so the
  // worker can pick the matching quality tier and repaint full quality on settle.
  readonly cameraMotion: CameraMotion;
  // Volume-view projection (slices are always screen-aligned ortho). The app forwards it; the
  // worker swaps the volume camera + flips the raymarch ray generation.
  readonly projection: CameraProjection;
  // One-shot fly-to request (gnomon axis snap, fit-to-data, view presets). ui/pointerCamera — the
  // owner of the camera animation loop — consumes it: resolves the target (fit needs the canvas
  // aspect only it knows), eases the pose over, and clears the request. A fresh wrapper object per
  // request so repeating the same view re-fires the subscription.
  readonly cameraFlyRequest: { readonly target: CameraFlyTarget } | null;
  // One-shot pick request (single-click places the marker, double-click focuses). ui dispatches the
  // cursor NDC + aspect + purpose; the app consumes it — asks the render worker for the
  // opacity-weighted pick (falling back to the box-chord midpoint pre-ready) and routes the result by
  // purpose (place → setPickerPoint; focus → setPickerPoint + cameraFlyRequest). Fresh wrapper per
  // request so a repeated same-spot click re-fires. `focusDistance` is the goal distance the focus
  // gesture committed to at double-click time — ui starts the fly immediately, so recomputing ×0.7
  // when the refined pick lands would compound against the already-flying pose.
  readonly pickRequest: {
    readonly ndcX: number;
    readonly ndcY: number;
    readonly aspect: number;
    readonly purpose: PickPurpose;
    readonly focusDistance?: number;
  } | null;
  // The draggable point-picker marker, object space (unit box [-0.5, 0.5]³, = world). null hides it.
  // ui/pointerPicker drags it (setPickerPoint) and the app's opacity-weighted pick places it; the app
  // forwards it to the render worker via pickerSync. The seed [0,0,0] shows the marker at box center.
  readonly pickerPoint: Vec3 | null;
  // Which marker part the cursor is over, and whether a drag is in progress — view feedback the
  // render worker eases (hover/pulse/active). Set by ui/pointerPicker, forwarded by pickerSync.
  readonly pickerHover: MarkerPart;
  readonly pickerActive: boolean;
  // Time cursor: the active timestep + the discrete domain the scrub control walks. The reader's
  // availableTimesteps seeds `availableSteps` (setAvailableSteps); setStep moves the cursor, tracking
  // the loaded dataset's `step` — the streaming worker re-reads on the change.
  readonly currentStep: number;
  readonly availableSteps: readonly number[];
  // The instance-first scene: an ordered list of renderable layers (draw order = array order) and
  // the selected one. For now the store auto-seeds exactly one layer for the active field.
  readonly layers: readonly Layer[];
  readonly selectedLayerId: string | null;
  // Scene overlay (axes + grid + gnomon) display prefs — user-owned, independent of the dataset. The
  // app forwards the render-bound parts to the worker (sceneSync); cameraChrome consumes showGnomon.
  readonly overlay: OverlayState;
  readonly status: SimulationStatus;
  readonly error: string | null;
  // Render diagnostics: the latest GPU frame time + its clock, and the panel's explicit "Measure"
  // toggle (drives the worker's continuous-repaint mode for sustained timing). `null` until the
  // first frame; the app forwards `frameTiming` worker replies via setFrameTiming.
  readonly frameTimeMs: number | null;
  readonly frameTimeClock: FrameClock | null;
  readonly isMeasuringContinuous: boolean;
  setDataset(dataset: FieldDataset): void;
  selectDataset(id: string): void;
  selectField(name: FieldName): void;
  setBindingColormap(id: string, colormap: ColormapId): void;
  setBindingWindow(id: string, center: number, width: number): void;
  setBindingScale(id: string, scale: ColorScale): void;
  setCameraPose(pose: CameraPose): void;
  setCameraMotion(motion: CameraMotion): void;
  setProjection(projection: CameraProjection): void;
  requestCameraFly(target: CameraFlyTarget | null): void;
  requestPick(
    request: {
      ndcX: number;
      ndcY: number;
      aspect: number;
      purpose: PickPurpose;
      focusDistance?: number;
    } | null,
  ): void;
  setPickerPoint(point: Vec3 | null): void;
  setPickerHover(part: MarkerPart): void;
  setPickerActive(active: boolean): void;
  setOverlayShowPicker(on: boolean): void;
  setStep(step: number): void;
  setAvailableSteps(steps: readonly number[]): void;
  addLayer(spec: LayerSpec): void;
  removeLayer(id: string): void;
  selectLayer(id: string | null): void;
  reorderLayer(id: string, toIndex: number): void;
  setLayerVisible(id: string, visible: boolean): void;
  setLayerOpacity(id: string, opacity: number): void;
  setLayerShading(id: string, shaded: boolean): void;
  setOverlayShowGrid(on: boolean): void;
  setOverlayPlane(plane: GridPlane, on: boolean): void;
  setOverlayShowAxes(on: boolean): void;
  setOverlayShowLabels(on: boolean): void;
  setOverlayShowGnomon(on: boolean): void;
  setGridDivisions(n: number): void;
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

// Element-wise step-domain equality, for identity-skipping a no-op setAvailableSteps.
function sameSteps(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Closest member of a domain (ties → the lower index), to keep the cursor valid when the
// available-step domain changes under it. An empty domain leaves the step unchanged.
function nearestStep(step: number, steps: readonly number[]): number {
  let best = step;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of steps) {
    const d = Math.abs(step - s);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
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
          // No Layers UI yet: auto-seed one volume layer + its binding for the active field so the
          // field selector + colormap panel still drive the scene. Only when empty — re-selecting a
          // field or reloading must not spawn duplicates.
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
        datasetId: DEFAULT_DATASET_ID,
        worldHalfExtent: UNIT_HALF_EXTENT,
        activeField: DEFAULT_FIELD,
        availableFields: [],
        computed: null,
        dataRange: null,
        colormapBindings: {},
        cameraPose: DEFAULT_POSE,
        cameraMotion: "idle",
        projection: "perspective",
        cameraFlyRequest: null,
        pickRequest: null,
        pickerPoint: [0, 0, 0],
        pickerHover: "none",
        pickerActive: false,
        currentStep: 0,
        availableSteps: [],
        layers: [],
        selectedLayerId: null,
        overlay: DEFAULT_OVERLAY,
        status: "empty",
        error: null,
        frameTimeMs: null,
        frameTimeClock: null,
        isMeasuringContinuous: false,
        setDataset(dataset) {
          // The cursor tracks the loaded step; a direct/synthetic load (no reader listing) still
          // needs a valid 1-element domain, while a reader-populated one (setAvailableSteps) stays.
          const { availableSteps } = get();
          set({
            dataset,
            worldHalfExtent: worldHalfExtentForGrid(dataset.grid),
            availableFields: computableFields(dataset),
            currentStep: dataset.step,
            ...(availableSteps.length === 0 ? { availableSteps: [dataset.step] } : {}),
          });
          recompute();
        },
        selectDataset(id) {
          if (id === get().datasetId) return; // unchanged → no fire (the app reacts to a real switch)
          set({ datasetId: id });
        },
        selectField(name) {
          if (name === get().activeField) return; // recompute yields a fresh array — skip the no-op re-render
          // The one layer follows the field selector — re-point it so its `field` stays honest
          // (the spread preserves the union member's kind-specific keys).
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
        setCameraMotion(motion) {
          if (motion === get().cameraMotion) return; // unchanged → no fire
          set({ cameraMotion: motion });
        },
        setProjection(projection) {
          if (projection === get().projection) return; // unchanged → no fire
          set({ projection });
        },
        requestCameraFly(target) {
          set({ cameraFlyRequest: target === null ? null : { target } });
        },
        requestPick(request) {
          set({ pickRequest: request === null ? null : { ...request } });
        },
        setPickerPoint(point) {
          set({ pickerPoint: point === null ? null : ([point[0], point[1], point[2]] as Vec3) });
        },
        setPickerHover(part) {
          if (part === get().pickerHover) return; // unchanged → no fire
          set({ pickerHover: part });
        },
        setPickerActive(active) {
          if (active === get().pickerActive) return; // unchanged → no fire
          set({ pickerActive: active });
        },
        setOverlayShowPicker(on) {
          const { overlay } = get();
          const next = overlayOps.setShowPicker(overlay, on);
          if (next === overlay) return;
          set({ overlay: next });
        },
        setStep(step) {
          const { currentStep, availableSteps } = get();
          if (step === currentStep) return; // unchanged → no fire
          if (!availableSteps.includes(step)) return; // outside the domain → ignore (controls emit only valid steps)
          set({ currentStep: step });
        },
        setAvailableSteps(steps) {
          const { availableSteps, currentStep } = get();
          if (sameSteps(availableSteps, steps)) return; // identical domain → no fire
          const snapped = nearestStep(currentStep, steps); // keep the cursor inside the new domain
          set({
            availableSteps: [...steps], // own a copy — external mutation can't corrupt the cursor domain
            ...(snapped !== currentStep ? { currentStep: snapped } : {}),
          });
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
          // Orphaned bindings are left in the registry — GC/merge wait for the multi-layer UI.
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
        setLayerShading(id, shaded) {
          const { layers } = get();
          const next = layerOps.setLayerShading(layers, id, shaded);
          if (next === layers) return;
          set({ layers: next });
        },
        setOverlayShowGrid(on) {
          const { overlay } = get();
          const next = overlayOps.setShowGrid(overlay, on);
          if (next === overlay) return;
          set({ overlay: next });
        },
        setOverlayPlane(plane, on) {
          const { overlay } = get();
          const next = overlayOps.setPlane(overlay, plane, on);
          if (next === overlay) return;
          set({ overlay: next });
        },
        setOverlayShowAxes(on) {
          const { overlay } = get();
          const next = overlayOps.setShowAxes(overlay, on);
          if (next === overlay) return;
          set({ overlay: next });
        },
        setOverlayShowLabels(on) {
          const { overlay } = get();
          const next = overlayOps.setShowLabels(overlay, on);
          if (next === overlay) return;
          set({ overlay: next });
        },
        setOverlayShowGnomon(on) {
          const { overlay } = get();
          const next = overlayOps.setShowGnomon(overlay, on);
          if (next === overlay) return;
          set({ overlay: next });
        },
        setGridDivisions(n) {
          const { overlay } = get();
          const next = overlayOps.setGridDivisions(overlay, n);
          if (next === overlay) return;
          set({ overlay: next });
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
