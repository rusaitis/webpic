import type { FieldDataset } from "@containers/field_dataset.ts";
import type { DataHandle, DataStreamRequest, DataStreamResponse } from "@data";
import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import type { Theme } from "@schema/theme.ts";
import {
  BOOT_PHASE_KEY,
  type CameraPose,
  type CameraProjection,
  createSimulationStore,
  createUiStore,
  cursorRay,
  focusPoseOnPoint,
  type SimulationStore,
  type UiStore,
  unitBoxChordMidpoint,
} from "@store";
import { installPointerCamera, installPointerPicker, installUi } from "@ui";
import type { DatasetEntry } from "./datasets.ts";
import { installLayerSync } from "./layerSync.ts";
import { installPickerSync } from "./pickerSync.ts";
import { installSceneSync } from "./sceneSync.ts";
import { createSyntheticDataset } from "./syntheticDataset.ts";

const DEFAULT_SIZE = 256;
const INIT_REQUEST_ID = 1;
const PROJECTION_REQUEST_ID = 2;
const POSE_REQUEST_ID = 3;
const CONTINUOUS_REQUEST_ID = 4;
const RESIZE_REQUEST_ID = 5;
const PAIR_REQUEST_ID = 6;
const STREAM_REQUEST_ID = 7;
const MOTION_REQUEST_ID = 8;
const PICK_REQUEST_ID = 10; // layerSync owns 9
// Cap the drawing-buffer scale: a raymarcher's cost is per physical pixel, so honor Retina (2×)
// but don't quadruple the work on 3×+ panels.
const MAX_DEVICE_PIXEL_RATIO = 2;

function currentDevicePixelRatio(): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return Math.max(1, Math.min(dpr || 1, MAX_DEVICE_PIXEL_RATIO));
}

// Terminal GPU-loss state: the worker's recovery circuit-breaker gave up. Replace the dead view with
// a reload prompt rather than leaving a frozen canvas. Idempotent; skipped headless (no DOM).
function showGpuLostBanner(message: string): void {
  if (typeof document === "undefined" || document.getElementById("webpic-gpu-lost") !== null)
    return;
  const banner = document.createElement("div");
  banner.id = "webpic-gpu-lost";
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed;inset:0;z-index:1000;display:grid;place-items:center;gap:1rem;padding:2rem;text-align:center;background:rgba(16,24,32,0.94);color:#e8eef4;font:500 14px/1.5 system-ui,sans-serif;";
  const text = document.createElement("p");
  text.style.cssText = "margin:0;max-width:40rem;";
  text.textContent = `GPU device lost and could not recover. ${message}`;
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.style.cssText =
    "padding:0.5rem 1.25rem;font:inherit;cursor:pointer;border-radius:6px;border:1px solid #4a5a6a;background:#1c2a38;color:inherit;";
  reload.addEventListener("click", () => location.reload());
  banner.append(text, reload);
  document.body.appendChild(banner);
}

// Seams default to the real DOM/Worker; the handshake test injects fakes so
// bootstrap runs headless in Node.
export interface BootstrapOptions {
  readonly width?: number;
  readonly height?: number;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly mount?: (canvas: HTMLCanvasElement) => void;
  readonly spawnWorker?: () => Worker;
  /** Spawns the data/streaming worker (M2.10a); only spawned when `streamSource` is set. */
  readonly spawnDataWorker?: () => Worker;
  /** A multi-step source to stream timesteps from (the scrub cursor drives it). Omit → no streaming
   *  (single-step dataset; the scrub control stays disabled). The default app entry passes the
   *  synthetic flux-rope handle. */
  readonly streamSource?: DataHandle;
  /** The dataset to render; defaults to the synthetic scaffold dataset. */
  readonly dataset?: FieldDataset;
  /** The selectable datasets (dropdown). When the store's `datasetId` changes, the matching entry's
   *  dataset is seeded on the main thread and the stream is re-opened onto its handle. Omit → the
   *  dropdown is inert (a single fixed dataset). */
  readonly datasetCatalog?: ReadonlyMap<string, DatasetEntry>;
  /** Theme for overlay colors (axes/grid/labels). Omitted → the gnomon-matching fallback palette. */
  readonly theme?: Theme;
  /** Initial camera pose (the `?pose=` permalink). Seeded into the store before the worker spawns,
   *  so the existing ready-time pose replay carries it — no extra protocol. */
  readonly initialPose?: CameraPose;
  /** Initial volume-view projection (the `&proj=ortho` permalink); the ready-time catch-up posts
   *  any non-perspective value to the worker. */
  readonly initialProjection?: CameraProjection;
  /** The simulation store; defaults to a fresh one. Injectable so a test can drive intents
   *  (e.g. setStep) and observe the resulting worker messages. */
  readonly store?: SimulationStore;
  /** The UI store; defaults to a fresh one. Injectable so a test can observe loading phases. */
  readonly uiStore?: UiStore;
  /** Where the UI overlay mounts; defaults to document.body, skipped when there's no DOM
   *  (the headless handshake test). Injectable so tests can mount into a scratch element. */
  readonly uiParent?: HTMLElement;
  /** Fires when the worker reports its first rendered frame — the perf-gate signal. */
  readonly onFirstFrame?: () => void;
  /** Render the RGB test triangle while no layers exist (`?debugScene`) — a "renderer alive,
   *  data missing" diagnostic. Off by default: the boot frame is the bare clear color. */
  readonly debugScene?: boolean;
}

export function bootstrap(options: BootstrapOptions = {}): () => void {
  const width = options.width ?? DEFAULT_SIZE;
  const height = options.height ?? DEFAULT_SIZE;

  const createCanvas =
    options.createCanvas ??
    (() => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    });
  const mount =
    options.mount ??
    ((canvas: HTMLCanvasElement) => {
      // The FCP splash pill lives outside #app and survives this; installStatusPill adopts it.
      (document.getElementById("app") ?? document.body).replaceChildren(canvas);
    });
  const spawnWorker =
    options.spawnWorker ??
    // Literal `new Worker(new URL(...))` so Vite emits the worker as its own chunk.
    (() => new Worker(new URL("../render/worker.ts", import.meta.url), { type: "module" }));

  const canvas = createCanvas();
  mount(canvas);

  // Logical (CSS) size from the mounted, full-viewport element; explicit options win for the
  // headless handshake test. The worker scales these by devicePixelRatio for the drawing buffer.
  const logicalSize = (): { width: number; height: number } => ({
    width: options.width ?? (canvas.clientWidth || DEFAULT_SIZE),
    height: options.height ?? (canvas.clientHeight || DEFAULT_SIZE),
  });
  const initial = logicalSize();

  const offscreen = canvas.transferControlToOffscreen();

  const worker = spawnWorker();
  const store = options.store ?? createSimulationStore();
  if (options.initialPose !== undefined) store.getState().setCameraPose(options.initialPose);
  if (options.initialProjection !== undefined)
    store.getState().setProjection(options.initialProjection);
  const uiStore = options.uiStore ?? createUiStore();
  // "webpic" matches the index.html splash text, so the splash→pill adoption is pixel-stable.
  uiStore.getState().beginLoading(BOOT_PHASE_KEY, "webpic");
  let workerReady = false;

  // Streaming worker (M2.10a): spawned only when a multi-step source is given. It reads + computes
  // each scrubbed step off-main and streams the scalar straight to the render worker over a private
  // MessageChannel (no main hop); main only relays the timestep domain (→ setAvailableSteps) and
  // drives the cursor. The channel's port2 pairs into the render worker on `ready`; port1 rides the
  // `open` message to the data worker after the store seeds its layer.
  const streamSource = options.streamSource;
  const dataWorker =
    streamSource !== undefined
      ? (
          options.spawnDataWorker ??
          (() =>
            new Worker(new URL("../workers/data.worker.ts", import.meta.url), {
              type: "module",
            }))
        )()
      : undefined;
  const streamChannel = dataWorker !== undefined ? new MessageChannel() : undefined;
  let dataWorkerOpened = false; // gates cursor/field posts until the worker has its reader
  if (dataWorker !== undefined) {
    dataWorker.onmessage = (event: MessageEvent<DataStreamResponse>) => {
      const message = event.data;
      if (message.kind === "opened") {
        store.getState().setAvailableSteps(message.steps); // override the 1-element seed
        uiStore.getState().endLoading("open");
      } else if (message.kind === "stepLoaded") {
        // Only the ack for the *current* cursor ends the phase — a stale ack in transit
        // from a scrubbed-past step must not clear the newer load's pill.
        if (message.step === store.getState().currentStep) uiStore.getState().endLoading("step");
      } else if (message.kind === "streamError") {
        console.error("[data worker]", message.message);
        uiStore.getState().endLoading("open");
        uiStore.getState().endLoading("step");
        uiStore.getState().flashError(message.message);
      }
    };
  }

  // Orbit/dolly/pan input. transferControlToOffscreen() moves only the drawing surface — the
  // <canvas> element still receives DOM pointer/wheel events on the main thread, so listeners attach
  // here and dispatch setCameraPose. Guarded so the headless handshake test's fake canvas (no
  // addEventListener) is left untouched.
  const disposePointer =
    typeof canvas.addEventListener === "function" ? installPointerCamera(canvas, store) : undefined;

  // Point-picker pointer input (capture-phase, so it pre-empts the camera when grabbing the marker).
  // Same fake-canvas guard as the camera controls. ui → store only; the worker draws the marker.
  const disposePicker =
    typeof canvas.addEventListener === "function" ? installPointerPicker(canvas, store) : undefined;

  // The layer registry → worker bridge (instance-first composite). Owns the `computed`/`layers`
  // subscriptions: a fresh field transfers its buffer via upsertLayer; structure changes ride the
  // cheap setComposite. Gated on `workerReady` so nothing is posted before the renderer is live.
  const layerSync = installLayerSync({ store, worker, isReady: () => workerReady });

  // The scene-overlay (axes + grid) bridge: forwards the store's overlay flags + the dataset bounds +
  // the resolved theme palette to the worker. Same workerReady gating + ready-time flushAll as layerSync.
  const sceneSync = installSceneSync({
    store,
    worker,
    isReady: () => workerReady,
    ...(options.theme !== undefined ? { theme: options.theme } : {}),
  });

  // The point-picker bridge: forwards the marker build config (theme colors) + the live position/state
  // to the worker. Same workerReady gating + ready-time flushAll as sceneSync.
  const pickerSync = installPickerSync({
    store,
    worker,
    isReady: () => workerReady,
    ...(options.theme !== undefined ? { theme: options.theme } : {}),
  });

  // Per-layer color (colormap / window-drag / scale) is owned by layerSync's bindings channel —
  // it resolves a changed ColormapBinding to the layers that reference it and posts setLayerColormap.

  // Camera pose rides the same cheap-message pattern. Pose is always present (DEFAULT_POSE), and the
  // worker already applied it at init, so there's no catch-up post on `ready` — this fires only on
  // user-driven changes (M2.4b pointer input). Until then it's inert.
  const unsubscribePose = store.subscribe(
    (state) => state.cameraPose,
    (pose) => {
      if (workerReady) {
        const request: RenderWorkerRequest = {
          kind: "setCameraPose",
          requestId: POSE_REQUEST_ID,
          pose,
        };
        worker.postMessage(request);
      }
    },
  );

  // Volume-view projection (persp ↔ ortho). Same cheap-message pattern as pose; the default is
  // perspective on both sides, so only user flips post (plus the ready catch-up below).
  const unsubscribeProjection = store.subscribe(
    (state) => state.projection,
    (projection) => {
      if (workerReady) {
        worker.postMessage({
          kind: "setProjection",
          requestId: PROJECTION_REQUEST_ID,
          projection,
        } satisfies RenderWorkerRequest);
      }
    },
  );

  // Pick-to-focus (double-click): forward the cursor NDC to the worker's opacity-weighted ray
  // march; its pickResult below answers with a cameraFlyRequest. Pre-ready there's no field to
  // weight by, so fall back to the box-chord midpoint (the same store math ui used for the hit
  // test) — the gesture still focuses, just geometrically.
  const unsubscribePick = store.subscribe(
    (state) => state.pickRequest,
    (request) => {
      if (request === null) return;
      const { ndcX, ndcY, aspect, purpose, focusDistance } = request;
      if (workerReady) {
        worker.postMessage({
          kind: "pickRay",
          requestId: PICK_REQUEST_ID,
          ndcX,
          ndcY,
          purpose,
          // exactOptionalPropertyTypes: forward the field only when the gesture carried it.
          ...(focusDistance !== undefined ? { focusDistance } : {}),
        } satisfies RenderWorkerRequest);
      } else {
        // Pre-ready there's no field to weight by — fall back to the box-chord midpoint, routed by
        // purpose like the worker's pickResult below (place → marker; focus → marker + camera).
        const state = store.getState();
        const ray = cursorRay(
          state.cameraPose,
          ndcX,
          ndcY,
          aspect,
          state.projection === "orthographic",
        );
        const point = unitBoxChordMidpoint(ray.origin, ray.dir, state.worldHalfExtent);
        if (point !== null) {
          state.setPickerPoint(point);
          if (purpose === "focus") {
            state.requestCameraFly({
              kind: "pose",
              pose: focusPoseOnPoint(state.cameraPose, point, focusDistance),
            });
          }
        }
      }
      store.getState().requestPick(null); // consume — same-spot clicks re-fire
    },
  );

  // Camera-motion liveness → worker quality tier (gesture = coarse march, fly = crisp animating
  // tier). Same cheap-message pattern as pose; the idle edge's repaint restores full quality.
  const unsubscribeInteracting = store.subscribe(
    (state) => state.cameraMotion,
    (motion) => {
      if (workerReady) {
        worker.postMessage({
          kind: "setCameraMotion",
          requestId: MOTION_REQUEST_ID,
          motion,
        } satisfies RenderWorkerRequest);
      }
    },
  );

  // Viewport/DPR tracking. ResizeObserver is frame-aligned, so post directly (no extra debounce).
  // Guarded like installPointerCamera so the headless fake canvas (no addEventListener) is untouched.
  const postResize = (): void => {
    if (!workerReady) return; // init carried the first layout; a pre-ready resize is vanishingly rare
    const size = logicalSize();
    worker.postMessage({
      kind: "resize",
      requestId: RESIZE_REQUEST_ID,
      width: size.width,
      height: size.height,
      devicePixelRatio: currentDevicePixelRatio(),
    } satisfies RenderWorkerRequest);
  };
  let disposeResize: (() => void) | undefined;
  if (typeof canvas.addEventListener === "function" && typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(postResize);
    observer.observe(canvas);
    disposeResize = () => observer.disconnect();
  }

  // A monitor move can change devicePixelRatio with no CSS resize — the ResizeObserver never fires
  // and the drawing buffer keeps the stale scale. The standard self-re-arming matchMedia loop: each
  // query matches only the current DPR, so its one `change` means "DPR is now something else".
  let disposeDprWatch: (() => void) | undefined;
  if (typeof canvas.addEventListener === "function" && typeof matchMedia === "function") {
    let query: MediaQueryList | undefined;
    const onDprChange = (): void => {
      postResize();
      arm();
    };
    const arm = (): void => {
      query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener("change", onDprChange, { once: true });
    };
    arm();
    disposeDprWatch = () => query?.removeEventListener("change", onDprChange);
  }

  worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
    const message = event.data;
    if (message.kind === "ready") {
      workerReady = true;
      // The compute typically finished before init; push the full layer state now that the
      // renderer is live (upsert each active-field layer + the composite).
      layerSync.flushAll();
      // Catch-up the overlay too: its subscription drops posts pre-ready, and setDataset already ran.
      sceneSync.flushAll();
      // Same for the picker marker (config + seeded center position).
      pickerSync.flushAll();
      // Catch-up: the pose subscription drops posts while !workerReady, so replay the current pose
      // once — a drag during worker init updates the store + gnomon but would otherwise be lost.
      worker.postMessage({
        kind: "setCameraPose",
        requestId: POSE_REQUEST_ID,
        pose: store.getState().cameraPose,
      } satisfies RenderWorkerRequest);
      // Same for a projection flipped during init (the worker boots perspective).
      if (store.getState().projection !== "perspective") {
        worker.postMessage({
          kind: "setProjection",
          requestId: PROJECTION_REQUEST_ID,
          projection: store.getState().projection,
        } satisfies RenderWorkerRequest);
      }
      // Pair the data worker's streaming port (M2.10a) now the renderer is live, so streamed steps
      // flow data → render directly. Buffered until the render worker sets the port's onmessage.
      if (streamChannel !== undefined) {
        worker.postMessage(
          {
            kind: "pair",
            requestId: PAIR_REQUEST_ID,
            port: streamChannel.port2,
          } satisfies RenderWorkerRequest,
          [streamChannel.port2],
        );
      }
      // The mark's startTime is ms since navigation, which scripts/perf-gate.ts reads
      // alongside First Contentful Paint to check the gate.
      performance.mark("webpic:first-frame");
      uiStore.getState().endLoading(BOOT_PHASE_KEY);
      options.onFirstFrame?.();
    } else if (message.kind === "frameTiming") {
      store.getState().setFrameTiming(message.gpuTimeMs, message.clock);
    } else if (message.kind === "pickResult") {
      // null = the ray missed the box; ui already handled background double-clicks synchronously.
      if (message.point !== null) {
        // Both purposes move the marker to the picked point; "focus" retargets the fly ui already
        // started toward the chord midpoint (double-click focuses on the marker — magviz
        // semantics). The echoed gesture-time distance keeps the ×0.7 dolly from compounding
        // against the already-flying pose.
        store.getState().setPickerPoint(message.point);
        if (message.purpose === "focus") {
          const pose = focusPoseOnPoint(
            store.getState().cameraPose,
            message.point,
            message.focusDistance,
          );
          store.getState().requestCameraFly({ kind: "pose", pose });
        }
      }
    } else if (message.kind === "error") {
      console.error("[render worker]", message.message);
    } else if (message.kind === "gpuRecoveryFailed") {
      console.error(`[render worker] GPU unrecoverable (${message.reason}):`, message.message);
      uiStore.getState().endLoading(BOOT_PHASE_KEY); // no spinner behind the terminal banner
      showGpuLostBanner(message.message);
    }
  };

  // Diagnostics: the panel's "Measure" toggle drives the worker's continuous-repaint mode for
  // sustained GPU timing. Same cheap-message pattern as pose; guarded on workerReady.
  const unsubscribeContinuous = store.subscribe(
    (state) => state.isMeasuringContinuous,
    (continuous) => {
      if (workerReady) {
        const request: RenderWorkerRequest = {
          kind: "setContinuous",
          requestId: CONTINUOUS_REQUEST_ID,
          continuous,
        };
        worker.postMessage(request);
      }
    },
  );

  // Streaming cursor + active-field → data worker. The scrub control moves `currentStep`; the field
  // selector moves `activeField`. Both ride the same guarded cheap-message pattern as pose; the
  // worker re-reads + re-streams off-main. Gated on `dataWorkerOpened` so nothing posts before the
  // worker has its reader (`setDataset` sets currentStep = dataset.step, which is the default 0 → no
  // pre-open fire). Subscriptions are inert when no data worker was spawned.
  let hasStreamedStep = false; // the worker only re-streams a field switch after a first scrub
  const unsubscribeStep = store.subscribe(
    (state) => state.currentStep,
    (step) => {
      if (dataWorker !== undefined && dataWorkerOpened) {
        dataWorker.postMessage({
          kind: "setCursor",
          requestId: STREAM_REQUEST_ID,
          step,
        } satisfies DataStreamRequest);
        hasStreamedStep = true;
        // Rapid scrubs just retitle the live "step" phase; the stepLoaded ack ends it.
        // Cached neighbours ack within ms — inside the pill's show delay, so no flash.
        uiStore.getState().beginLoading("step", `loading step ${step}`);
      }
    },
  );
  const unsubscribeActiveField = store.subscribe(
    (state) => state.activeField,
    (field) => {
      if (dataWorker !== undefined && dataWorkerOpened) {
        dataWorker.postMessage({
          kind: "setActiveField",
          requestId: STREAM_REQUEST_ID,
          field,
        } satisfies DataStreamRequest);
        // Pre-scrub the worker has no cursor and never acks (main's synchronous layerSync
        // covers that case) — an unconditional begin would strand the phase forever.
        if (hasStreamedStep) uiStore.getState().beginLoading("step", `computing ${field}`);
      }
    },
  );

  // Dataset switch (the dropdown): the store records `datasetId`; rebuild the dataset here (the app
  // owns the catalog — store/ui can't reach `data`), seed it on the main thread for an instant frame,
  // reset the look to the dataset's default color scale, and re-open the stream onto the new handle so
  // the time domain + streamed steps follow. Inert when no catalog/worker was wired.
  const unsubscribeDatasetId = store.subscribe(
    (state) => state.datasetId,
    (id) => {
      const entry = options.datasetCatalog?.get(id);
      if (entry === undefined) return;
      store.getState().setDataset(entry.makeDataset());
      const state = store.getState();
      const layer = state.layers.find((candidate) => candidate.id === state.selectedLayerId);
      const bindingId = layer?.colormapBindingId ?? null;
      if (bindingId !== null) state.setBindingScale(bindingId, entry.defaultScale);
      if (dataWorker !== undefined && dataWorkerOpened) {
        uiStore.getState().beginLoading("open", "opening dataset");
        dataWorker.postMessage({
          kind: "reopen",
          requestId: STREAM_REQUEST_ID,
          handle: entry.streamSource,
          activeField: store.getState().activeField,
        } satisfies DataStreamRequest);
      }
    },
  );

  const request: RenderWorkerRequest = {
    kind: "init",
    requestId: INIT_REQUEST_ID,
    canvas: offscreen,
    width: initial.width,
    height: initial.height,
    devicePixelRatio: currentDevicePixelRatio(),
    ...(options.debugScene === true ? { debugScene: true } : {}),
  };
  worker.postMessage(request, [offscreen]); // transfer the OffscreenCanvas

  store.getState().setDataset(options.dataset ?? createSyntheticDataset());

  // Open the streaming source now the store has seeded its layer (streamed fields address it by id).
  // port1 rides the open (transferred); the worker reports the timestep domain via `opened`.
  if (dataWorker !== undefined && streamChannel !== undefined && streamSource !== undefined) {
    const layerId = store.getState().selectedLayerId;
    if (layerId !== null) {
      uiStore.getState().beginLoading("open", "opening dataset");
      dataWorker.postMessage(
        {
          kind: "open",
          requestId: STREAM_REQUEST_ID,
          handle: streamSource,
          activeField: store.getState().activeField,
          layerId,
          port: streamChannel.port1,
        } satisfies DataStreamRequest,
        [streamChannel.port1],
      );
      dataWorkerOpened = true;
    }
  }

  // Mount the UI after the dataset so the field selector sees the computed
  // availableFields. Skipped headless (no DOM) — the overlay is a sibling to the canvas,
  // not in the render path, so the worker handshake is unaffected.
  const uiParent =
    options.uiParent ?? (typeof document !== "undefined" ? document.body : undefined);
  const disposeUi = uiParent
    ? installUi({ parent: uiParent, simulationStore: store, uiStore })
    : undefined;

  return () => {
    disposeUi?.();
    disposePointer?.();
    disposePicker?.();
    disposeResize?.();
    disposeDprWatch?.();
    layerSync.dispose();
    sceneSync.dispose();
    pickerSync.dispose();
    unsubscribePose();
    unsubscribeProjection();
    unsubscribePick();
    unsubscribeInteracting();
    unsubscribeContinuous();
    unsubscribeStep();
    unsubscribeActiveField();
    unsubscribeDatasetId();
    dataWorker?.terminate();
    worker.terminate();
  };
}
