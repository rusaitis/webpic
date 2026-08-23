import type { FieldDataset } from "@containers/field_dataset.ts";
import type { DataHandle } from "@data";
import { writeThemePref } from "@data/theme/prefs.ts";
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
import {
  applyUiVars,
  installPointerCamera,
  installPointerPicker,
  installPointerSeedPlacer,
  installUi,
} from "@ui";
import { showBlockingBanner } from "./blockingBanner.ts";
import type { DatasetEntry } from "./datasets.ts";
import { installLayerSync } from "./layerSync.ts";
import type { PerfBridge } from "./perfBridge.ts";
import { installPickerSync } from "./pickerSync.ts";
import { installRenderWorkerSync } from "./renderWorkerSync.ts";
import { installSceneSync } from "./sceneSync.ts";
import { installScreenshotBridge } from "./screenshotBridge.ts";
import { installStreamingBridge, type StreamingBridge } from "./streamingBridge.ts";
import { createSyntheticDataset } from "./syntheticDataset.ts";
import { installThemeBridge, type ThemeBridge } from "./themeBridge.ts";
import { currentDevicePixelRatio, installViewportTracking } from "./viewportTracking.ts";

const DEFAULT_SIZE = 256;

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
  /** Bundled theme catalog (name → Theme, insertion order = cycle order) enabling the runtime
   *  theme switcher (rail button). Omit → the switcher stays disabled; `theme` is the boot theme. */
  readonly themeCatalog?: ReadonlyMap<string, Theme>;
  /** Persists the theme choice; defaults to the OPFS pref writer. Injectable for tests. */
  readonly persistTheme?: (name: string) => Promise<void>;
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
  /** Auto-add a field-line layer (default seed rake) once the dataset lands (`?fieldlines`) — a dev /
   *  screenshot affordance; the rail's `+Field lines` button / `T` shortcut do the same
   *  interactively. */
  readonly fieldlines?: boolean;
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
  // Seed placer first: its capture-phase listener must run before the picker's so it claims the click
  // while in placement mode (a seed, not a marker grab / orbit).
  const disposeSeedPlacer = hasPointerEvents ? installPointerSeedPlacer(canvas, store) : undefined;
  const disposePointer = hasPointerEvents ? installPointerCamera(canvas, store) : undefined;
  const disposePicker = hasPointerEvents ? installPointerPicker(canvas, store) : undefined;

  // Store→worker bridges (app-only glue: store and render can't import each other). Each gates its
  // posts on `isReady` and replays the live state via flushAll on the worker `ready`.
  const theme = options.theme !== undefined ? { theme: options.theme } : {};
  const layerSync = installLayerSync({ store, uiStore, worker, isReady });
  const sceneSync = installSceneSync({ store, worker, isReady, ...theme });
  const pickerSync = installPickerSync({ store, worker, isReady, ...theme });
  const renderSync = installRenderWorkerSync({ store, worker, isReady });
  const screenshotBridge = installScreenshotBridge({ store, uiStore, worker, isReady });
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
          // Every field-drawing layer, not just the selected one — a field-lines layer is selected by
          // its own add, and its binding only tints a line color, so scoping the scale to the
          // selection can leave the volume linear (all-black on the dipole). setBindingScale
          // identity-skips, so shared bindings cost nothing.
          for (const layer of state.layers) {
            if (layer.kind !== "volume" && layer.kind !== "slice") continue;
            if (layer.colormapBindingId !== null)
              state.setBindingScale(layer.colormapBindingId, entry.defaultScale);
          }
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
    } else if (message.kind === "screenshot") {
      screenshotBridge.handleScreenshot(message);
    } else if (message.kind === "error") {
      console.error("[render worker]", message.message);
      // Pre-first-frame it is fatal (no adapter, no device, pipeline failure): the status pill
      // auto-clears, so without a banner the user is left staring at an empty canvas.
      if (!workerReady) {
        uiStore.getState().endLoading(BOOT_PHASE_KEY);
        showBlockingBanner("webpic could not start the WebGPU renderer.", {
          detail: message.message,
          reload: true,
        });
      }
    } else if (message.kind === "gpuRecoveryFailed") {
      console.error(`[render worker] GPU unrecoverable (${message.reason}):`, message.message);
      uiStore.getState().endLoading(BOOT_PHASE_KEY); // no spinner behind the terminal banner
      showBlockingBanner(`GPU device lost and could not recover. ${message.message}`, {
        reload: true,
      });
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
  // Auto-add the field-line layer once the seed lands (dataset.grid is needed for the default rake,
  // and the active field computed). The traces ride layerSync's traces channel (or its ready catch-up).
  const seedFieldlines = (): void => {
    if (options.fieldlines === true) store.getState().addFieldlinesLayer();
  };
  const dataset = options.dataset ?? createSyntheticDataset();
  if (streaming !== undefined) {
    void store
      .getState()
      .setDataset(dataset)
      .then(() => {
        streaming?.open();
        seedFieldlines();
      });
  } else {
    void store.getState().setDataset(dataset).then(seedFieldlines);
  }

  // Mount the UI after the dataset so the field selector sees the computed availableFields. Skipped
  // headless (no DOM) — the overlay is a sibling to the canvas, not in the render path.
  const uiParent =
    options.uiParent ?? (typeof document !== "undefined" ? document.body : undefined);
  const disposeUi = uiParent
    ? installUi({ parent: uiParent, simulationStore: store, uiStore, ...theme })
    : undefined;

  // Runtime theme switcher: the rail button cycles the catalog; every switch re-applies the CSS
  // vars + the worker overlay/marker palettes live and persists the choice. Layout/shortcuts stay
  // from the boot theme (identical across the bundled color themes).
  let themeBridge: ThemeBridge | undefined;
  const themeCatalog = options.themeCatalog;
  if (themeCatalog !== undefined && themeCatalog.size > 0 && uiParent !== undefined) {
    const firstName = themeCatalog.keys().next().value;
    const initialName = options.theme?.name ?? firstName;
    if (initialName !== undefined) {
      themeBridge = installThemeBridge({
        uiStore,
        themes: themeCatalog,
        initialName,
        applyTheme: (next) => {
          applyUiVars(uiParent, next);
          sceneSync.setTheme(next);
          pickerSync.setTheme(next);
        },
        persist: options.persistTheme ?? writeThemePref,
      });
    }
  }

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

  // Dev-only shader HMR: forward an edited raymarch WGSL/TSL to the worker (rebuildShader) instead of
  // the default full page reload, so the camera pose + uploaded volume survive an edit. Behind
  // import.meta.hot + dynamic-imported, so the bridge is absent from the prod bundle.
  let disposeShaderHmr: (() => void) | undefined;
  let shaderHmrDisposed = false;
  if (import.meta.hot) {
    void import("./shaderHmr.ts").then(({ installShaderHmr }) => {
      if (shaderHmrDisposed) return; // bootstrap disposed before the chunk loaded
      disposeShaderHmr = installShaderHmr(worker);
    });
  }

  return () => {
    perfDisposed = true;
    perfBridge?.dispose();
    themeBridge?.dispose();
    shaderHmrDisposed = true;
    disposeShaderHmr?.();
    disposeUi?.();
    disposeSeedPlacer?.();
    disposePointer?.();
    disposePicker?.();
    viewport.dispose();
    layerSync.dispose();
    sceneSync.dispose();
    pickerSync.dispose();
    renderSync.dispose();
    screenshotBridge.dispose();
    unsubscribeDatasetId();
    streaming?.dispose();
    worker.terminate();
  };
}
