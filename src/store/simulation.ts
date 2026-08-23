import { computableFields, computeField, type FieldLine, traceFields } from "@compute";
import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import type { ColormapBinding, ColormapId, ColorScale, WindowLevel } from "@schema/colormap.ts";
import { DEFAULT_DATASET_ID } from "@schema/datasets.ts";
import type { MarkerPart, PickPurpose } from "@schema/marker.ts";
import { UNIT_BOX_HALF_EXTENT, vec3 } from "@schema/math.ts";
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
import type { Layer, LayerKind, LayerSpec, SliceAxis } from "./layers.ts";
import * as layerOps from "./layers.ts";
import * as overlayOps from "./overlay.ts";
import { DEFAULT_OVERLAY, type GridPlane, type OverlayState } from "./overlay.ts";
import { defaultSeedRake } from "./seedPick.ts";

export type { WindowLevel };

// The simulation store: holds the loaded dataset + active field, recomputes the derived field
// whenever either changes, and owns the instance-first `layers` registry. UI dispatches
// `setDataset`/`selectField`/layer intents; the app subscribes to `computed`/`layers` and forwards
// to the render worker (the store never touches `render` — the DAG forbids it).
//
// One store by design: subscribeWithSelector already gives per-field subscriptions, the app reads
// many slices together, and pypic-parity favors a single "simulation" object. Revisit a scene/data
// split only when a multi-layer UI or animation timeline forces it.

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
  // The ColormapBinding registry (DESIGN §Store schema additions): the color-mapping layers reference by id, owning
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
  // Traced field lines per fieldlines-layer id (compute/traceField). recompute/addFieldlinesLayer
  // refresh it; the app bridges each entry to the render worker as a batched LineSegments2.
  readonly traces: Readonly<Record<string, FieldLine[]>>;
  // Seed-placement mode: the fieldlines-layer id accepting click-to-place seeds, or null (off). The
  // per-layer settings panel toggles it; ui/pointerSeedPlacer claims canvas clicks while it is set.
  readonly seedPlacementLayerId: string | null;
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
  // setDataset/selectField recompute the active field through the async dispatcher — they resolve once
  // the field is computed + the layer/binding seeded, so callers that depend on the seed (bootstrap's
  // stream open) can await; the UI just reacts to the computed/status subscription.
  setDataset(dataset: FieldDataset): Promise<void>;
  selectDataset(id: string): void;
  selectField(name: FieldName): Promise<void>;
  setBindingColormap(id: string, colormap: ColormapId): void;
  setBindingWindow(id: string, center: number, width: number): void;
  setBindingScale(id: string, scale: ColorScale): void;
  setCameraPose(pose: CameraPose): void;
  setCameraMotion(motion: CameraMotion): void;
  setProjection(projection: CameraProjection): void;
  setFlyMode(on: boolean): void;
  toggleFlyMode(): void;
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
  /** Add a volume layer on the active field, then recompute so it gets scalar data + a scene. The
   *  rail's `+Volume` button / `V` shortcut dispatch this. */
  addVolumeLayer(): void;
  /** Add a mid-plane z slice on the active field, then recompute so it gets scalar data + a scene.
   *  The rail's `+Slice` button dispatches this. */
  addSliceLayer(): void;
  /** Add a field-line layer seeded with a default rake over the current dataset, then trace it. The
   *  DESIGN-reserved `T` shortcut / the rail's `+Field lines` button dispatch this. */
  addFieldlinesLayer(): void;
  removeLayer(id: string): void;
  selectLayer(id: string | null): void;
  reorderLayer(id: string, toIndex: number): void;
  setLayerVisible(id: string, visible: boolean): void;
  setLayerOpacity(id: string, opacity: number): void;
  setLayerShading(id: string, shaded: boolean): void;
  /** Set a slice layer's held axis (live — the app forwards it to the render worker). */
  setSliceAxis(id: string, axis: SliceAxis): void;
  /** Set a slice layer's plane position along the held axis, [0, 1] (live). */
  setSlicePosition(id: string, position: number): void;
  /** Replace a fieldlines layer's seed set, then re-trace. */
  setFieldlineSeeds(id: string, seeds: ReadonlyArray<Vec3>): void;
  /** Regenerate a fieldlines layer's seeds as a default rake of `count` over the dataset, then trace. */
  setFieldlineSeedCount(id: string, count: number): void;
  /** Append one physical-grid seed to a fieldlines layer, then re-trace (the click-to-place path). */
  addFieldlineSeed(id: string, seed: Vec3): void;
  /** Enter (`id`) or leave (`null`) click-to-place seed mode for a fieldlines layer. */
  setSeedPlacement(id: string | null): void;
  setOverlayShowGrid(on: boolean): void;
  setOverlayPlane(plane: GridPlane, on: boolean): void;
  setOverlayShowAxes(on: boolean): void;
  setOverlayShowLabels(on: boolean): void;
  setOverlayShowGnomon(on: boolean): void;
  setGridDivisions(n: number): void;
  setFrameTiming(ms: number, clock: FrameClock): void;
  setMeasuringContinuous(on: boolean): void;
}

/** The selected layer, or null when nothing is selected (or the id no longer resolves). The single
 *  reader of the selected-layer chain — UI panels select through this rather than re-deriving it. */
export function selectActiveLayer(
  state: Pick<SimulationState, "layers" | "selectedLayerId">,
): Layer | null {
  if (state.selectedLayerId === null) return null;
  return state.layers.find((layer) => layer.id === state.selectedLayerId) ?? null;
}

/** The ColormapBinding bound to the selected layer, or null when none is selected/bound. */
export function selectActiveBinding(
  state: Pick<SimulationState, "layers" | "selectedLayerId" | "colormapBindings">,
): ColormapBinding | null {
  const bindingId = selectActiveLayer(state)?.colormapBindingId ?? null;
  return bindingId === null ? null : (state.colormapBindings[bindingId] ?? null);
}

/** The distinct ColormapBindings referenced by *visible* layers, in draw order (first reference
 *  wins). The colorbar's content model (DESIGN §UI): shared bindings collapse to one entry, hidden
 *  layers contribute nothing. Fresh array per call — subscribe with a shallow equalityFn. */
export function selectVisibleBindings(
  state: Pick<SimulationState, "layers" | "colormapBindings">,
): readonly ColormapBinding[] {
  const out: ColormapBinding[] = [];
  for (const layer of state.layers) {
    if (!layer.visible || layer.colormapBindingId === null) continue;
    const binding = state.colormapBindings[layer.colormapBindingId];
    if (binding !== undefined && !out.includes(binding)) out.push(binding);
  }
  return out;
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

      // The overlay/bindings/layers setters all share one shape: read the slice, run a pure op, and
      // commit only a real change — an unchanged result must NOT fire subscribeWithSelector (it would
      // spuriously re-render). These helpers state that identity-skip invariant once.
      const updateOverlay = (op: (overlay: OverlayState) => OverlayState): void => {
        const { overlay } = get();
        const next = op(overlay);
        if (next !== overlay) set({ overlay: next });
      };
      const updateBindings = (
        op: (
          bindings: Readonly<Record<string, ColormapBinding>>,
        ) => Readonly<Record<string, ColormapBinding>>,
      ): void => {
        const { colormapBindings } = get();
        const next = op(colormapBindings);
        if (next !== colormapBindings) set({ colormapBindings: next });
      };
      const updateLayers = (op: (layers: readonly Layer[]) => readonly Layer[]): void => {
        const { layers } = get();
        const next = op(layers);
        if (next !== layers) set({ layers: next });
      };

      // Bumped on every recompute so an async compute that loses a race (a newer setDataset/selectField
      // started while it awaited) discards instead of committing a stale field/error — the pull-based
      // invalidation counter (DESIGN §compute) in its v0.1 shape.
      let computeGeneration = 0;
      // Cancels the superseded compute's in-flight work (a GPU trace, an async backend): the
      // generation counter only discards the stale *result*, this also stops the work producing it.
      let computeAbort: AbortController | null = null;

      const recompute = async (): Promise<void> => {
        const generation = ++computeGeneration;
        computeAbort?.abort();
        computeAbort = null;
        const { dataset, activeField } = get();
        if (dataset === null) {
          // Leave `layers`/`colormapBindings`/`selectedLayerId` untouched — a transient empty/error
          // state shouldn't tear down the layer + binding the field selector targets.
          set({ computed: null, status: "empty", error: null, dataRange: null });
          return;
        }
        const controller = new AbortController();
        computeAbort = controller;
        try {
          const computed = await computeField(activeField, dataset, controller.signal);
          if (generation !== computeGeneration) return; // superseded mid-compute — drop the stale result
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
          // Field lines trace the vector field, not the active scalar — but a dataset switch lands
          // through here too, so refresh any existing field-line layers against the new dataset.
          // Fire-and-forget: retrace is total (owns its own abort + generation guard), never rejects.
          if (layers.some((layer) => layer.kind === "fieldlines")) void retrace();
        } catch (err) {
          if (generation !== computeGeneration) return; // superseded — don't clobber with a stale error
          set({
            computed: null,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            dataRange: null,
          });
        }
      };

      // The trace twin of computeGeneration/computeAbort: bumped on every retrace so a superseded pass
      // (a newer dataset switch / layer add started while it awaited) discards instead of committing
      // stale lines; the controller cancels the superseded trace's in-flight work (the CPU tracer
      // checks it per integration step).
      let traceGeneration = 0;
      let traceAbort: AbortController | null = null;

      // Re-trace every field-line layer's seeds from the current dataset's vector field
      // (compute/traceField), publishing FieldLine[] per layer id. Mirrors recompute's per-call
      // AbortController + generation guard — aborts the prior pass and drops a superseded result. A
      // per-layer try/catch keeps a dataset without B_1/B_2/B_3 (or seeds gone stale after a dataset
      // switch) from crashing the store — that layer just renders line-less. Total (never rejects), so
      // callers fire it with `void`. recompute doesn't abort traceAbort on its own supersede — moot
      // while CPU traces are synchronous (the next retrace aborts it). Off-main + GPU dispatch + scrub
      // re-trace stay deferred behind the worker/main-device seam.
      const retrace = async (): Promise<void> => {
        const generation = ++traceGeneration;
        traceAbort?.abort();
        traceAbort = null;
        const { dataset, layers, traces } = get();
        if (dataset === null) {
          if (Object.keys(traces).length > 0) set({ traces: {} }); // identity-skip when already empty
          return;
        }
        const controller = new AbortController();
        traceAbort = controller;
        const next: Record<string, FieldLine[]> = {};
        for (const layer of layers) {
          if (layer.kind !== "fieldlines" || layer.seeds.length === 0) continue;
          try {
            next[layer.id] = await traceFields(
              dataset,
              layer.seeds,
              { direction: "both" },
              controller.signal,
            );
          } catch (err) {
            if (controller.signal.aborted) return; // superseded mid-trace — the newer retrace owns the commit
            console.warn(`[webpic] field-line trace failed for ${layer.id}:`, err);
          }
        }
        if (generation !== traceGeneration) return; // superseded between the last await and the commit
        // Identity-skip when nothing traced and nothing was traced before (no spurious subscriber fire).
        if (Object.keys(next).length === 0 && Object.keys(traces).length === 0) return;
        set({ traces: next });
      };

      return {
        dataset: null,
        datasetId: DEFAULT_DATASET_ID,
        worldHalfExtent: UNIT_BOX_HALF_EXTENT,
        activeField: DEFAULT_FIELD,
        availableFields: [],
        computed: null,
        dataRange: null,
        colormapBindings: {},
        cameraPose: DEFAULT_POSE,
        cameraMotion: "idle",
        projection: "perspective",
        isFlyMode: false,
        cameraFlyRequest: null,
        pickRequest: null,
        pickerPoint: [0, 0, 0],
        pickerHover: "none",
        pickerActive: false,
        currentStep: 0,
        availableSteps: [],
        layers: [],
        selectedLayerId: null,
        traces: {},
        seedPlacementLayerId: null,
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
          return recompute(); // resolves once the seed lands — callers may await (bootstrap sequences on it)
        },
        selectDataset(id) {
          if (id === get().datasetId) return; // unchanged → no fire (the app reacts to a real switch)
          set({ datasetId: id });
        },
        selectField(name) {
          if (name === get().activeField) return Promise.resolve(); // no-op — skip the re-render
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
          return recompute(); // resolves once the seed lands — callers may await (bootstrap sequences on it)
        },
        setBindingColormap(id, colormap) {
          updateBindings((b) => colormapOps.setBindingColormap(b, id, colormap));
        },
        setBindingWindow(id, center, width) {
          updateBindings((b) => colormapOps.setBindingWindow(b, id, center, width));
        },
        setBindingScale(id, scale) {
          updateBindings((b) => colormapOps.setBindingScale(b, id, scale));
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
        setFlyMode(on) {
          if (on === get().isFlyMode) return; // unchanged → no fire
          set({ isFlyMode: on });
        },
        toggleFlyMode() {
          set({ isFlyMode: !get().isFlyMode });
        },
        requestCameraFly(target) {
          set({ cameraFlyRequest: target === null ? null : { target } });
        },
        requestPick(request) {
          set({ pickRequest: request === null ? null : { ...request } });
        },
        setPickerPoint(point) {
          set({ pickerPoint: point === null ? null : vec3(point[0], point[1], point[2]) });
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
          updateOverlay((o) => overlayOps.setShowPicker(o, on));
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
        addVolumeLayer() {
          const { dataset, activeField } = get();
          if (dataset === null) return; // no field data to draw yet
          get().addLayer({
            kind: "volume",
            field: activeField,
            colormapBindingId: null,
            visible: true,
            opacity: 1,
            steps: null,
            density: null,
            shaded: false,
          });
          // A bare addLayer touches only `layers`/bindings, not `computed`, whose buffer was
          // transferred (detached) on the prior upsert — recompute refills it so layerSync's
          // `computed` channel upserts a scene for the new layer (mirrors retrace for field lines).
          void recompute();
        },
        addSliceLayer() {
          const { dataset, activeField } = get();
          if (dataset === null) return;
          get().addLayer({
            kind: "slice",
            field: activeField,
            colormapBindingId: null,
            visible: true,
            opacity: 1,
            axis: "z",
            position: 0.5,
          });
          void recompute(); // see addVolumeLayer — refills the detached `computed` buffer
        },
        addFieldlinesLayer() {
          const { dataset, activeField } = get();
          if (dataset === null) return; // nothing to seed/trace yet
          const seeds = defaultSeedRake(dataset.grid);
          // Reuse addLayer to mint the id + a ColormapBinding, then trace the rake.
          get().addLayer({
            kind: "fieldlines",
            field: activeField,
            colormapBindingId: null,
            visible: true,
            opacity: 1,
            seeds,
          });
          void retrace(); // total (owns its abort + generation guard), never rejects
        },
        removeLayer(id) {
          // Orphaned bindings are left in the registry — GC/merge wait for the multi-layer UI.
          const { layers, selectedLayerId, seedPlacementLayerId } = get();
          const next = layerOps.removeLayer(layers, id);
          if (next === layers) return; // absent id → no-op
          const selected = selectedLayerId === id ? (next[0]?.id ?? null) : selectedLayerId;
          set({
            layers: next,
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
        setOverlayShowGrid(on) {
          updateOverlay((o) => overlayOps.setShowGrid(o, on));
        },
        setOverlayPlane(plane, on) {
          updateOverlay((o) => overlayOps.setPlane(o, plane, on));
        },
        setOverlayShowAxes(on) {
          updateOverlay((o) => overlayOps.setShowAxes(o, on));
        },
        setOverlayShowLabels(on) {
          updateOverlay((o) => overlayOps.setShowLabels(o, on));
        },
        setOverlayShowGnomon(on) {
          updateOverlay((o) => overlayOps.setShowGnomon(o, on));
        },
        setGridDivisions(n) {
          updateOverlay((o) => overlayOps.setGridDivisions(o, n));
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
