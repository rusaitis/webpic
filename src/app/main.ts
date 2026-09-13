import type { FieldDataset } from "@containers/field_dataset.ts";
import type { DataHandle } from "@data";
import { writeThemePref } from "@data/theme/prefs.ts";
import {
  REQUEST_IDS,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
} from "@render/messages.ts";
import { rejectionLogger } from "@schema/log.ts";
import type { Theme } from "@schema/theme.ts";
import {
  type CameraPose,
  type CameraProjection,
  createPerfStore,
  createSimulationStore,
  createUiStore,
  PHASE_KEYS,
  type SimulationStore,
  type UiStore,
} from "@store";
import {
  applyUiVars,
  createSubscriptions,
  type Disposer,
  installPointerCamera,
  installPointerPicker,
  installPointerSeedPlacer,
  installUi,
} from "@ui";
import { routeWorkerResponse } from "./_workerRouter.ts";
import { installLayerBridge } from "./bridges/layerBridge.ts";
import type { PerfBridge } from "./bridges/perfBridge.ts";
import { installPickerBridge } from "./bridges/pickerBridge.ts";
import { installRenderWorkerBridge } from "./bridges/renderWorkerBridge.ts";
import { installSceneBridge } from "./bridges/sceneBridge.ts";
import { installScreenshotBridge } from "./bridges/screenshotBridge.ts";
import { installStreamingBridge, type StreamingBridge } from "./bridges/streamingBridge.ts";
import { installThemeBridge } from "./bridges/themeBridge.ts";
import { currentDevicePixelRatio, installViewportBridge } from "./bridges/viewportBridge.ts";
import { createCanvasHost } from "./canvasHost.ts";
import { installDatasetSwitch } from "./datasetSwitch.ts";
import { createSyntheticDataset, type DatasetEntry } from "./datasets.ts";

// The worker's orderly subscriptions normally acks in a few ms; terminate regardless after this so a wedged
// worker can't hold the page's own subscriptions hostage.
export const DISPOSE_GRACE_MS = 250;

// Seams default to the real DOM/Worker; the handshake test injects fakes so
// bootstrap runs headless in Node.
export interface BootstrapOptions {
  readonly width?: number;
  readonly height?: number;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly mount?: (canvas: HTMLCanvasElement) => void;
  readonly spawnWorker?: () => Worker;
  // Spawns the data/streaming worker; only spawned when `streamSource` is set.
  readonly spawnDataWorker?: () => Worker;
  // A multi-step source to stream timesteps from (the scrub cursor drives it). Omit → no streaming
  // (single-step dataset; the scrub control stays disabled). The default app entry passes the
  // synthetic flux-rope handle.
  readonly streamSource?: DataHandle;
  // The dataset to render; defaults to the synthetic scaffold dataset.
  readonly dataset?: FieldDataset;
  // The selectable datasets (dropdown). When the store's `datasetId` changes, the matching entry's
  // dataset is seeded on the main thread and the stream is re-opened onto its handle. Omit → the
  // dropdown is inert (a single fixed dataset).
  readonly datasetCatalog?: ReadonlyMap<string, DatasetEntry>;
  // Theme for overlay colors (axes/grid/labels). Omitted → the gnomon-matching fallback palette.
  readonly theme?: Theme;
  // Bundled theme catalog (name → Theme, insertion order = cycle order) enabling the runtime
  // theme switcher (rail button). Omit → the switcher stays disabled; `theme` is the boot theme.
  readonly themeCatalog?: ReadonlyMap<string, Theme>;
  // Persists the theme choice; defaults to the OPFS pref writer. Injectable for tests.
  readonly persistTheme?: (name: string) => Promise<void>;
  // Initial camera pose (the `?pose=` permalink). Seeded into the store before the worker spawns,
  // so the existing ready-time pose replay carries it — no extra protocol.
  readonly initialPose?: CameraPose;
  // Initial volume-view projection (the `&proj=ortho` permalink); the ready-time catch-up posts
  // any non-perspective value to the worker.
  readonly initialProjection?: CameraProjection;
  // The simulation store; defaults to a fresh one. Injectable so a test can drive intents
  // (e.g. setStep) and observe the resulting worker messages.
  readonly store?: SimulationStore;
  // The UI store; defaults to a fresh one. Injectable so a test can observe loading phases.
  readonly uiStore?: UiStore;
  // Where the UI overlay mounts; defaults to document.body, skipped when there's no DOM
  // (the headless handshake test). Injectable so tests can mount into a scratch element.
  readonly uiParent?: HTMLElement;
  // Fires when the worker reports its first rendered frame — the perf-gate signal.
  readonly onFirstFrame?: () => void;
  // Render the RGB test triangle while no layers exist (`?debugScene`) — a "renderer alive,
  // data missing" diagnostic. Off by default: the boot frame is the bare clear color.
  readonly showDebugScene?: boolean;
  // Auto-add a field-line layer (default seed rake) once the dataset lands (`?fieldlines`) — a dev /
  // screenshot affordance; the rail's `+Field lines` button / `T` shortcut do the same
  // interactively.
  readonly fieldlines?: boolean;
  // Mount the dev performance HUD (Shift+P) + its worker sampling. The entry gates this on
  // import.meta.env.DEV || ?perf; the HUD + bridge are dynamic-imported so they tree-shake out of
  // the default production bundle.
  readonly perf?: boolean;
}

// A dev-only feature shipped as its own chunk: load it, install it unless bootstrap was disposed
// while the chunk was in flight, and return one disposer covering both outcomes. Two callers (the
// perf HUD and the shader-HMR bridge) wrote this shape identically.
function installLazy<M>(
  load: () => Promise<M>,
  install: (module: M) => Disposer,
  failureMessage: string,
): Disposer {
  let isDisposed = false;
  let disposeInstalled: Disposer | undefined;
  void load()
    .then((module) => {
      if (isDisposed) return;
      disposeInstalled = install(module);
    })
    .catch(rejectionLogger("app", failureMessage));
  return () => {
    isDisposed = true;
    disposeInstalled?.();
  };
}

export function bootstrap(options: BootstrapOptions = {}): () => void {
  const spawnWorker =
    options.spawnWorker ??
    // Literal `new Worker(new URL(...))` so Vite emits the worker as its own chunk.
    (() => new Worker(new URL("../render/worker.ts", import.meta.url), { type: "module" }));

  const { canvas, offscreen, logicalSize } = createCanvasHost(options);
  const initial = logicalSize();

  const worker = spawnWorker();
  const store = options.store ?? createSimulationStore();
  if (options.initialPose !== undefined) store.getState().setCameraPose(options.initialPose);
  if (options.initialProjection !== undefined)
    store.getState().setProjection(options.initialProjection);
  const uiStore = options.uiStore ?? createUiStore();
  // Every subscriptions registers where it is created, and runs LIFO from the returned disposer — so
  // adding a bridge cannot silently leave it running (CLAUDE.md §Lifecycle & shape).
  const subscriptions = createSubscriptions();
  // "webpic" matches the index.html splash text, so the splash→pill adoption is pixel-stable.
  uiStore.getState().beginLoading(PHASE_KEYS.boot, "webpic");
  let isWorkerReady = false;
  const isReady = (): boolean => isWorkerReady; // the bridges gate every post on this

  let perfBridge: PerfBridge | undefined; // set asynchronously when the perf feature is enabled

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
  if (hasPointerEvents) {
    subscriptions.add(installPointerSeedPlacer(canvas, store));
    subscriptions.add(installPointerCamera(canvas, store));
    subscriptions.add(installPointerPicker(canvas, store));
  }

  // Store→worker bridges (app-only glue: store and render can't import each other). Each gates its
  // posts on `isReady` and replays the live state via flushAll on the worker `ready`.
  const theme = options.theme !== undefined ? { theme: options.theme } : {};
  const layerBridge = installLayerBridge({ store, uiStore, worker, isReady });
  const sceneBridge = installSceneBridge({ store, worker, isReady, ...theme });
  const pickerBridge = installPickerBridge({ store, worker, isReady, ...theme });
  for (const bridge of [layerBridge, sceneBridge, pickerBridge]) subscriptions.add(bridge.dispose);
  const perfStore = createPerfStore(); // render timing for the timing panel + the dev HUD
  const renderBridge = installRenderWorkerBridge({ store, perfStore, worker, isReady });
  const screenshotBridge = installScreenshotBridge({ store, uiStore, worker, isReady });
  subscriptions.add(renderBridge.dispose);
  subscriptions.add(screenshotBridge.dispose);
  subscriptions.add(installViewportBridge({ canvas, worker, isReady, logicalSize }));

  // Withdraws every store load bootstrap started (the boot seed, a dataset switch) when it's disposed
  // mid-flight, so no compute lands on a torn-down app.
  const bootAbort = new AbortController();

  subscriptions.add(
    installDatasetSwitch({
      store,
      ...(options.datasetCatalog !== undefined ? { catalog: options.datasetCatalog } : {}),
      signal: bootAbort.signal,
      reopen: (entry) => streaming?.reopen(entry.streamSource),
    }),
  );

  // Catch-up once the renderer is live: the gated subscriptions dropped their pre-ready posts, so push
  // the full state (each bridge's flushAll), pair the streaming port, and clear the boot pill.
  const onWorkerReady = (): void => {
    layerBridge.flushAll();
    sceneBridge.flushAll();
    pickerBridge.flushAll();
    renderBridge.flushAll();
    streaming?.pair();
    // The mark's startTime is ms since navigation, which scripts/perf-gate.ts reads alongside First
    // Contentful Paint to check the gate.
    performance.mark("webpic:first-frame");
    uiStore.getState().endLoading(PHASE_KEYS.boot);
    options.onFirstFrame?.();
  };

  // Teardown handshake: dispose() posts `dispose`, the worker acks `disposed`, then terminate — or the
  // grace timer terminates first.
  let disposeTimer: ReturnType<typeof setTimeout> | undefined;
  const terminateWorker = (): void => {
    if (disposeTimer !== undefined) clearTimeout(disposeTimer);
    disposeTimer = undefined;
    worker.terminate();
  };

  worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
    routeWorkerResponse(event.data, {
      uiStore,
      perfStore,
      endBootPhase: () => uiStore.getState().endLoading(PHASE_KEYS.boot),
      isWorkerReady: () => isWorkerReady,
      onReady: () => {
        isWorkerReady = true;
        onWorkerReady();
      },
      ingestRenderSample: (message) => perfBridge?.ingestRenderSample(message),
      applyPickResult: (message) => renderBridge.applyPickResult(message),
      finishLayerLoading: () => layerBridge.finishLoading(),
      deliverScreenshot: (message) => screenshotBridge.deliverScreenshot(message),
      onDisposed: terminateWorker,
    });
  };

  worker.postMessage(
    {
      kind: "init",
      requestId: REQUEST_IDS.init,
      canvas: offscreen,
      width: initial.width,
      height: initial.height,
      devicePixelRatio: currentDevicePixelRatio(),
      ...(options.showDebugScene === true ? { showDebugScene: true } : {}),
    } satisfies RenderWorkerRequest,
    [offscreen],
  ); // transfer the OffscreenCanvas

  // The recompute that seeds the layer streamed fields address is async (compute is Promise-based), so
  // open the stream once that layer lands — open() carries its id. The UI reacts to computed/status
  // through its own subscription, so it needn't wait on this.
  // Auto-add the field-line layer once the seed lands (dataset.grid is needed for the default rake,
  // and the active field computed). The traces ride layerBridge's traces channel (or its ready catch-up).
  const seedFieldlines = (): void => {
    if (options.fieldlines === true) store.getState().addFieldlinesLayer();
  };
  const dataset = options.dataset ?? createSyntheticDataset();
  const seeded = store.getState().setDataset(dataset, bootAbort.signal);
  void seeded
    .then(() => {
      streaming?.open(); // no-op without a stream source
      seedFieldlines();
    })
    .catch(rejectionLogger("app", "dataset seed failed"));

  // Mount the UI after the dataset so the field selector sees the computed availableFields. Skipped
  // headless (no DOM) — the overlay is a sibling to the canvas, not in the render path.
  const uiParent =
    options.uiParent ?? (typeof document !== "undefined" ? document.body : undefined);
  if (uiParent)
    subscriptions.add(
      installUi({ parent: uiParent, simulationStore: store, perfStore, uiStore, ...theme }),
    );

  // Runtime theme switcher: the rail button cycles the catalog; every switch re-applies the CSS
  // vars + the worker overlay/marker palettes live and persists the choice. Layout/shortcuts stay
  // from the boot theme (identical across the bundled color themes).
  const themeCatalog = options.themeCatalog;
  if (themeCatalog !== undefined && themeCatalog.size > 0 && uiParent !== undefined) {
    const firstName = themeCatalog.keys().next().value;
    const initialName = options.theme?.name ?? firstName;
    if (initialName !== undefined) {
      subscriptions.add(
        installThemeBridge({
          uiStore,
          themes: themeCatalog,
          initialName,
          applyTheme: (next) => {
            applyUiVars(uiParent, next);
            sceneBridge.setTheme(next);
            pickerBridge.setTheme(next);
          },
          persist: options.persistTheme ?? writeThemePref,
        }),
      );
    }
  }

  // Dev performance HUD (Shift+P): the HUD overlay + worker sampling, dynamic-imported so the feature
  // is absent from the default prod bundle. Needs a DOM parent; skipped headless.
  if (options.perf === true && uiParent !== undefined) {
    subscriptions.add(
      installLazy(
        () => import("./bridges/perfBridge.ts"),
        ({ installPerf }) => {
          const bridge = installPerf({
            perfStore,
            uiStore,
            uiParent,
            renderWorker: worker,
            setDataPerfActive: (active) => streaming?.setPerfActive(active),
            isRenderReady: () => isWorkerReady,
            isDataPresent: () => streaming !== undefined,
          });
          perfBridge = bridge; // the streaming bridge forwards its samples here
          return () => bridge.dispose();
        },
        "perf HUD chunk failed to load",
      ),
    );
  }

  // Dev-only shader HMR: forward an edited raymarch WGSL/TSL to the worker (rebuildShader) instead of
  // the default full page reload, so the camera pose + uploaded volume survive an edit. Behind
  // import.meta.hot + dynamic-imported, so the bridge is absent from the prod bundle.
  if (import.meta.hot) {
    subscriptions.add(
      installLazy(
        () => import("./bridges/shaderHmrBridge.ts"),
        ({ installShaderHmr }) => installShaderHmr(worker),
        "shader HMR chunk failed to load",
      ),
    );
  }

  return () => {
    bootAbort.abort(); // first: withdraw in-flight loads before anything they'd commit into is gone
    subscriptions.dispose();
    streaming?.dispose();
    // Last: the worker frees its GPU resources on this, then gets a grace window to ack.
    worker.postMessage({
      kind: "dispose",
      requestId: REQUEST_IDS.dispose,
    } satisfies RenderWorkerRequest);
    disposeTimer = setTimeout(terminateWorker, DISPOSE_GRACE_MS);
  };
}
