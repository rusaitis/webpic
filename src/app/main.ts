import type { FieldDataset } from "@containers/field_dataset.ts";
import type { DataHandle } from "@data";
import {
  REQUEST_IDS,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
} from "@render/messages.ts";
import type { Theme } from "@schema/theme.ts";
import {
  BOOT_PHASE_KEY,
  type CameraPose,
  type CameraProjection,
  createPerfStore,
  createSimulationStore,
  createUiStore,
  type SimulationStore,
  type UiStore,
} from "@store";
import { installPointerCamera, installPointerPicker, installUi } from "@ui";
import type { DatasetEntry } from "./datasets.ts";
import { installLayerSync } from "./layerSync.ts";
import type { PerfBridge } from "./perfBridge.ts";
import { installPickerSync } from "./pickerSync.ts";
import { installRenderWorkerSync } from "./renderWorkerSync.ts";
import { installSceneSync } from "./sceneSync.ts";
import { installStreamingBridge, type StreamingBridge } from "./streamingBridge.ts";
import { createSyntheticDataset } from "./syntheticDataset.ts";
import { currentDevicePixelRatio, installViewportTracking } from "./viewportTracking.ts";

const DEFAULT_SIZE = 256;

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
  /** Spawns the data/streaming worker; only spawned when `streamSource` is set. */
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
  /** Mount the dev performance HUD (Shift+P) + its worker sampling. The entry gates this on
   *  import.meta.env.DEV || ?perf; the HUD + bridge are dynamic-imported so they tree-shake out of
   *  the default production bundle. */
  readonly perf?: boolean;
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

  // Logical (CSS) size from the mounted, full-viewport element; explicit options win for the headless
  // handshake test. The worker scales these by devicePixelRatio for the drawing buffer.
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
  const isReady = (): boolean => workerReady; // the bridges gate every post on this

  let perfBridge: PerfBridge | undefined; // set asynchronously when the perf feature is enabled
  let perfDisposed = false; // guards the async perf chunk landing after an early dispose

  // Streaming data worker: spawned only when a multi-step source is given (else the scrub control
  // stays disabled and the bridges are absent — a single fixed dataset).
  const streamSource = options.streamSource;
  let streaming: StreamingBridge | undefined;
  if (streamSource !== undefined) {
    const spawnDataWorker =
      options.spawnDataWorker ??
      (() => new Worker(new URL("../workers/data.worker.ts", import.meta.url), { type: "module" }));
    streaming = installStreamingBridge({
      store,
      uiStore,
      renderWorker: worker,
      dataWorker: spawnDataWorker(),
      streamSource,
      onPerfSample: (sample) => perfBridge?.ingestDataSample(sample),
    });
  }

  // Orbit/dolly/pan + point-picker pointer input on the main-thread canvas (ui → store only; the
  // worker draws the marker). transferControlToOffscreen() moves only the drawing surface, so the
  // <canvas> still receives DOM events here. Guarded so the headless fake canvas is left untouched.
  const hasPointerEvents = typeof canvas.addEventListener === "function";
  const disposePointer = hasPointerEvents ? installPointerCamera(canvas, store) : undefined;
  const disposePicker = hasPointerEvents ? installPointerPicker(canvas, store) : undefined;

  // Store→worker bridges (app-only glue: store and render can't import each other). Each gates its
  // posts on `isReady` and replays the live state via flushAll on the worker `ready`.
  const theme = options.theme !== undefined ? { theme: options.theme } : {};
  const layerSync = installLayerSync({ store, uiStore, worker, isReady });
  const sceneSync = installSceneSync({ store, worker, isReady, ...theme });
  const pickerSync = installPickerSync({ store, worker, isReady, ...theme });
  const renderSync = installRenderWorkerSync({ store, worker, isReady });
  const viewport = installViewportTracking({ canvas, worker, isReady, logicalSize });

  // Dataset switch (the dropdown): the store records `datasetId`; rebuild the dataset here (the app
  // owns the catalog — store/ui can't reach `data`), seed it on the main thread for an instant frame,
  // reset the look to the dataset's default color scale, and re-open the stream onto the new handle.
  // Inert when no catalog was wired; `reopen` is a no-op when there's no stream.
  const unsubscribeDatasetId = store.subscribe(
    (state) => state.datasetId,
    (id) => {
      const entry = options.datasetCatalog?.get(id);
      if (entry === undefined) return;
      // setDataset re-seeds asynchronously; apply the dataset's default scale to the retargeted binding
      // and re-open the stream onto the new handle once that lands.
      void store
        .getState()
        .setDataset(entry.makeDataset())
        .then(() => {
          const state = store.getState();
          const layer = state.layers.find((candidate) => candidate.id === state.selectedLayerId);
          const bindingId = layer?.colormapBindingId ?? null;
          if (bindingId !== null) state.setBindingScale(bindingId, entry.defaultScale);
          streaming?.reopen(entry.streamSource);
        });
    },
  );

  // Catch-up once the renderer is live: the gated subscriptions dropped their pre-ready posts, so push
  // the full state (each bridge's flushAll), pair the streaming port, and clear the boot pill.
  const onWorkerReady = (): void => {
    layerSync.flushAll();
    sceneSync.flushAll();
    pickerSync.flushAll();
    renderSync.flushAll();
    streaming?.pair();
    // The mark's startTime is ms since navigation, which scripts/perf-gate.ts reads alongside First
    // Contentful Paint to check the gate.
    performance.mark("webpic:first-frame");
    uiStore.getState().endLoading(BOOT_PHASE_KEY);
    options.onFirstFrame?.();
  };

  worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
    const message = event.data;
    if (message.kind === "ready") {
      workerReady = true;
      onWorkerReady();
    } else if (message.kind === "frameTiming") {
      store.getState().setFrameTiming(message.gpuTimeMs, message.clock);
    } else if (message.kind === "perfSample") {
      perfBridge?.ingestRenderSample(message);
    } else if (message.kind === "pickResult") {
      renderSync.handlePickResult(message);
    } else if (message.kind === "layerCompiled") {
      layerSync.handleCompiled(); // the layer's pipeline is warm → drop the render-loading pill
    } else if (message.kind === "error") {
      console.error("[render worker]", message.message);
    } else if (message.kind === "gpuRecoveryFailed") {
      console.error(`[render worker] GPU unrecoverable (${message.reason}):`, message.message);
      uiStore.getState().endLoading(BOOT_PHASE_KEY); // no spinner behind the terminal banner
      showGpuLostBanner(message.message);
    }
  };

  const request: RenderWorkerRequest = {
    kind: "init",
    requestId: REQUEST_IDS.init,
    canvas: offscreen,
    width: initial.width,
    height: initial.height,
    devicePixelRatio: currentDevicePixelRatio(),
    ...(options.debugScene === true ? { debugScene: true } : {}),
  };
  worker.postMessage(request, [offscreen]); // transfer the OffscreenCanvas

  // The recompute that seeds the layer streamed fields address is async (compute is Promise-based), so
  // open the stream once that layer lands — open() carries its id. The UI reacts to computed/status
  // through its own subscription, so it needn't wait on this.
  const dataset = options.dataset ?? createSyntheticDataset();
  if (streaming !== undefined) {
    void store
      .getState()
      .setDataset(dataset)
      .then(() => streaming?.open());
  } else {
    void store.getState().setDataset(dataset);
  }

  // Mount the UI after the dataset so the field selector sees the computed availableFields. Skipped
  // headless (no DOM) — the overlay is a sibling to the canvas, not in the render path.
  const uiParent =
    options.uiParent ?? (typeof document !== "undefined" ? document.body : undefined);
  const disposeUi = uiParent
    ? installUi({ parent: uiParent, simulationStore: store, uiStore })
    : undefined;

  // Dev performance HUD (Shift+P): the HUD overlay + worker sampling, dynamic-imported so the feature
  // is absent from the default prod bundle. Needs a DOM parent; skipped headless.
  if (options.perf === true && uiParent !== undefined) {
    const perfStore = createPerfStore();
    void import("./perfBridge.ts").then(({ installPerf }) => {
      if (perfDisposed) return; // bootstrap disposed before the chunk loaded
      perfBridge = installPerf({
        perfStore,
        uiStore,
        uiParent,
        renderWorker: worker,
        setDataPerfActive: (active) => streaming?.setPerfActive(active),
        isRenderReady: () => workerReady,
        isDataPresent: () => streaming !== undefined,
      });
    });
  }

  return () => {
    perfDisposed = true;
    perfBridge?.dispose();
    disposeUi?.();
    disposePointer?.();
    disposePicker?.();
    viewport.dispose();
    layerSync.dispose();
    sceneSync.dispose();
    pickerSync.dispose();
    renderSync.dispose();
    unsubscribeDatasetId();
    streaming?.dispose();
    worker.terminate();
  };
}
