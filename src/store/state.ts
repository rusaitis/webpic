import type { FieldLine } from "@compute";
import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { ValueRange } from "@reductions";
import type { ColormapBinding, ColormapId, ColorScale } from "@schema/colormap.ts";
import type { LayerKind, SliceAxis } from "@schema/layers.ts";
import type { MarkerPart, PickPurpose } from "@schema/marker.ts";
import type { FieldName, Vec3 } from "@schema/types.ts";
import type { CameraFlyTarget, CameraMotion, CameraPose, CameraProjection } from "./camera.ts";
import type { Layer, LayerSpec } from "./layers.ts";
import type { GridPlane, OverlayState } from "./overlay.ts";

// The simulation store's shape, one slice per concern. Each slice is its own factory (dataSlice,
// layersSlice, …) composed into ONE zustand store by createSimulationStore, so subscribers still read
// dataset + layers + camera off a single object (subscribeWithSelector gives per-field granularity)
// while each concern's state + intents live in a file of their own.

// Full finite extent of the active field — the slider track bounds.
export type DataRange = ValueRange;

// The active field's lifecycle as one value: what is computed, its extent, or why it isn't — an
// illegal combination (a "ready" field with no data) cannot be represented.
export type FieldState =
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly computed: FieldArray; readonly dataRange: DataRange | null }
  | { readonly kind: "error"; readonly message: string };

// Per-layer outcome of a field-line retrace. `traced < requested` means seeds were skipped (a field
// null, or outside the domain after a dataset switch); `error` is a genuine trace failure.
export interface TraceNotice {
  readonly requested: number;
  readonly traced: number;
  readonly nullSeeds: number;
  readonly outsideSeeds: number;
  // Seeds that started but produced no usable line (a first step that leaves the domain both ways).
  readonly failedSeeds: number;
  // The vector the trace followed ("B", "E") — known even when nothing traced; null on a failure
  // that never reached the tracer.
  readonly fieldName: string | null;
  readonly error: string | null;
}

// One-shot pick request (single-click places the marker, double-click focuses). ui dispatches the
// cursor NDC + aspect + purpose; the app consumes it — asks the render worker for the opacity-weighted
// pick (falling back to the box-chord midpoint pre-ready) and routes the result by purpose (place →
// setPickerPoint; focus → setPickerPoint + cameraFlyRequest). `focusDistance` is the goal distance
// the focus gesture committed to at double-click time — ui starts the fly immediately, so recomputing
// ×0.7 when the refined pick lands would compound against the already-flying pose.
interface PickRequest {
  readonly ndcX: number;
  readonly ndcY: number;
  readonly aspect: number;
  readonly purpose: PickPurpose;
  readonly focusDistance?: number;
}

export interface DataSlice {
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
  readonly field: FieldState;
  // Time cursor: the active timestep + the discrete domain the scrub control walks. The reader's
  // availableTimesteps seeds `availableSteps` (setAvailableSteps); setStep moves the cursor, tracking
  // the loaded dataset's `step` — the streaming worker re-reads on the change.
  readonly currentStep: number;
  readonly availableSteps: readonly number[];
  // setDataset/selectField recompute the active field through the async dispatcher — they resolve once
  // the field is computed + the layer/binding seeded, so callers that depend on the seed (bootstrap's
  // stream open) can await; the UI just reacts to the `field` subscription. `signal` withdraws the
  // caller's interest (bootstrap disposed mid-load): the in-flight compute is cancelled and no state
  // is committed — distinct from a newer call superseding it.
  setDataset(dataset: FieldDataset, signal?: AbortSignal): Promise<void>;
  selectDataset(id: string): void;
  selectField(name: FieldName, signal?: AbortSignal): Promise<void>;
  // Recompute the active field from the current dataset. The app calls it once it has handed the
  // previous buffer to the renderer (a transfer detaches it) and a new layer needs the data.
  recomputeField(): Promise<void>;
  setStep(step: number): void;
  setAvailableSteps(steps: readonly number[]): void;
}

export interface LayersSlice {
  // The instance-first scene: an ordered list of renderable layers (draw order = array order) and
  // the selected one. The store auto-seeds one layer for the active field on the first compute.
  readonly layers: readonly Layer[];
  readonly selectedLayerId: string | null;
  // Traced field lines per fieldlines-layer id (compute/traceField). recompute/addFieldlinesLayer
  // refresh it; the app bridges each entry to the render worker as a batched LineSegments2.
  readonly traces: Readonly<Record<string, FieldLine[]>>;
  // What the last retrace of each fieldlines layer actually did — facts, not sentences: the UI writes
  // the wording. Committed with `traces`, so a layer that traced 6 of 8 seeds still renders its six.
  readonly traceNotices: Readonly<Record<string, TraceNotice>>;
  // Seed-placement mode: the fieldlines-layer id accepting click-to-place seeds, or null (off). The
  // per-layer settings panel toggles it; ui/pointerSeedPlacer claims canvas clicks while it is set.
  readonly seedPlacementLayerId: string | null;
  addLayer(spec: LayerSpec): void;
  // Add a fresh instance of `kind` on the active field (the rail's add buttons): a volume or slice
  // gets its field data from the app (which recomputes if the last buffer was transferred); a
  // field-line layer is seeded with a default rake over the dataset and traced. No-op without a
  // dataset.
  addLayerOfKind(kind: LayerKind): void;
  // The `T` shortcut and the `?fieldlines` boot flag.
  addFieldlinesLayer(): void;
  removeLayer(id: string): void;
  selectLayer(id: string | null): void;
  reorderLayer(id: string, toIndex: number): void;
  setLayerVisible(id: string, visible: boolean): void;
  setLayerOpacity(id: string, opacity: number): void;
  setLayerShading(id: string, shaded: boolean): void;
  // Set a slice layer's held axis (live — the app forwards it to the render worker).
  setSliceAxis(id: string, axis: SliceAxis): void;
  // Set a slice layer's plane position along the held axis, [0, 1] (live).
  setSlicePosition(id: string, position: number): void;
  // Replace a fieldlines layer's seed set, then re-trace.
  setFieldlineSeeds(id: string, seeds: ReadonlyArray<Vec3>): void;
  // Regenerate a fieldlines layer's seeds as a default rake of `count` over the dataset, then trace.
  setFieldlineSeedCount(id: string, count: number): void;
  // Append one physical-grid seed to a fieldlines layer, then re-trace (the click-to-place path).
  addFieldlineSeed(id: string, seed: Vec3): void;
  // Enter (`id`) or leave (`null`) click-to-place seed mode for a fieldlines layer.
  setSeedPlacement(id: string | null): void;
}

export interface BindingsSlice {
  // The ColormapBinding registry (DESIGN §Store schema additions): the color-mapping layers reference
  // by id, owning colormap + window/level + scale. Layers share or split bindings; GC/merge wait for
  // the multi-layer UI.
  readonly colormapBindings: Readonly<Record<string, ColormapBinding>>;
  setBindingColormap(id: string, colormap: ColormapId): void;
  setBindingWindow(id: string, center: number, width: number): void;
  setBindingScale(id: string, scale: ColorScale): void;
}

export interface CameraSlice {
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
  // Held-key navigation mode. false = orbit (A/D/Q/E swing the camera around the target); true = fly
  // (A/D/Q/E are first-person look, turning the view in place). A deliberate user toggle (rail button
  // / N), NOT auto-engaged by proximity — only W/S's close-up walk (dollyWithWalk) is automatic.
  // Transient interaction state, so it stays out of the pose permalink.
  readonly isFlyMode: boolean;
  // One-shot fly-to request (gnomon axis snap, fit-to-data, view presets). ui/pointerCamera — the
  // owner of the camera animation loop — consumes it: resolves the target (fit needs the canvas
  // aspect only it knows), eases the pose over, and clears the request. A fresh wrapper object per
  // request so repeating the same view re-fires the subscription.
  readonly cameraFlyRequest: { readonly target: CameraFlyTarget } | null;
  setCameraPose(pose: CameraPose): void;
  setCameraMotion(motion: CameraMotion): void;
  setProjection(projection: CameraProjection): void;
  setFlyMode(on: boolean): void;
  toggleFlyMode(): void;
  requestCameraFly(target: CameraFlyTarget | null): void;
}

export interface PickerSlice {
  // Fresh wrapper per request so a repeated same-spot click re-fires (see PickRequest).
  readonly pickRequest: PickRequest | null;
  // The draggable point-picker marker, object space (unit box [-0.5, 0.5]³, = world). null hides it.
  // ui/pointerPicker drags it (setPickerPoint) and the app's opacity-weighted pick places it; the app
  // forwards it to the render worker via pickerSync. The seed [0,0,0] shows the marker at box center.
  readonly pickerPoint: Vec3 | null;
  // Which marker part the cursor is over, and whether a drag is in progress — view feedback the
  // render worker eases (hover/pulse/active). Set by ui/pointerPicker, forwarded by pickerSync.
  readonly pickerHover: MarkerPart;
  readonly pickerActive: boolean;
  requestPick(request: PickRequest | null): void;
  setPickerPoint(point: Vec3 | null): void;
  setPickerHover(part: MarkerPart): void;
  setPickerActive(active: boolean): void;
}

export interface OverlaySlice {
  // Scene overlay (axes + grid + gnomon) display prefs — user-owned, independent of the dataset. The
  // app forwards the render-bound parts to the worker (sceneSync); cameraChrome consumes showGnomon.
  readonly overlay: OverlayState;
  setOverlayShowGrid(on: boolean): void;
  setOverlayPlane(plane: GridPlane, on: boolean): void;
  setOverlayShowAxes(on: boolean): void;
  setOverlayShowLabels(on: boolean): void;
  setOverlayShowGnomon(on: boolean): void;
  setOverlayShowPicker(on: boolean): void;
  setGridDivisions(n: number): void;
}

export type SimulationState = DataSlice &
  LayersSlice &
  BindingsSlice &
  CameraSlice &
  PickerSlice &
  OverlaySlice;

// What a slice factory is handed: the composed store's setter + getter (a slice may read any field —
// the layers slice reads the dataset to rake seeds — but writes only its own).
type StoreSet = (partial: Partial<SimulationState>) => void;
type StoreGet = () => SimulationState;
export interface SliceContext {
  readonly set: StoreSet;
  readonly get: StoreGet;
}

// Per-store monotonic ids shared by the slices that mint layers and bindings.
export interface SceneIds {
  nextLayerId(): string;
  nextBindingId(): string;
}

export function createSceneIds(): SceneIds {
  let layerSeq = 0;
  let bindingSeq = 0;
  return {
    nextLayerId: () => `layer-${layerSeq++}`,
    nextBindingId: () => `binding-${bindingSeq++}`,
  };
}
