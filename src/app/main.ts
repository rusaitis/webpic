import type { FieldDataset } from "@containers/field_dataset.ts";
import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { createSimulationStore, createUiStore } from "@store";
import { installPointerCamera, installUi } from "@ui";
import { installLayerSync } from "./layerSync.ts";
import { createSyntheticDataset } from "./syntheticDataset.ts";

const DEFAULT_SIZE = 256;
const INIT_REQUEST_ID = 1;
const WINDOW_REQUEST_ID = 2;
const POSE_REQUEST_ID = 3;

// Seams default to the real DOM/Worker; the handshake test injects fakes so
// bootstrap runs headless in Node.
export interface BootstrapOptions {
  readonly width?: number;
  readonly height?: number;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly mount?: (canvas: HTMLCanvasElement) => void;
  readonly spawnWorker?: () => Worker;
  /** The dataset to render; defaults to the synthetic scaffold dataset. */
  readonly dataset?: FieldDataset;
  /** Where the UI overlay mounts; defaults to document.body, skipped when there's no DOM
   *  (the headless handshake test). Injectable so tests can mount into a scratch element. */
  readonly uiParent?: HTMLElement;
  /** Fires when the worker reports its first rendered frame — the perf-gate signal. */
  readonly onFirstFrame?: () => void;
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
      // Replace the FCP splash with the canvas; FCP has already fired on the splash.
      (document.getElementById("app") ?? document.body).replaceChildren(canvas);
    });
  const spawnWorker =
    options.spawnWorker ??
    // Literal `new Worker(new URL(...))` so Vite emits the worker as its own chunk.
    (() => new Worker(new URL("../render/worker.ts", import.meta.url), { type: "module" }));

  const canvas = createCanvas();
  mount(canvas);
  const offscreen = canvas.transferControlToOffscreen();

  const worker = spawnWorker();
  const store = createSimulationStore();
  const uiStore = createUiStore();
  let workerReady = false;

  // Orbit/dolly/pan input. transferControlToOffscreen() moves only the drawing surface — the
  // <canvas> element still receives DOM pointer/wheel events on the main thread, so listeners attach
  // here and dispatch setCameraPose. Guarded so the headless handshake test's fake canvas (no
  // addEventListener) is left untouched.
  const disposePointer =
    typeof canvas.addEventListener === "function" ? installPointerCamera(canvas, store) : undefined;

  // The layer registry → worker bridge (instance-first composite). Owns the `computed`/`layers`
  // subscriptions: a fresh field transfers its buffer via upsertLayer; structure changes ride the
  // cheap setComposite. Gated on `workerReady` so nothing is posted before the renderer is live.
  const layerSync = installLayerSync({ store, worker, isReady: () => workerReady });

  // Window/level changes ride a cheap message (no field transfer) — the drag hot path is just
  // a uniform retune + repaint. A field switch fires both this and `computed`; the resulting
  // setWindowLevel is a redundant no-op over the freshly-built scene.
  const unsubscribeWindow = store.subscribe(
    (state) => state.windowLevel,
    (windowLevel) => {
      if (workerReady && windowLevel !== null) {
        const request: RenderWorkerRequest = {
          kind: "setWindowLevel",
          requestId: WINDOW_REQUEST_ID,
          windowLevel,
        };
        worker.postMessage(request);
      }
    },
  );

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

  worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
    const message = event.data;
    if (message.kind === "ready") {
      workerReady = true;
      // The compute typically finished before init; push the full layer state now that the
      // renderer is live (upsert each active-field layer + the composite).
      layerSync.flushAll();
      // The mark's startTime is ms since navigation, which scripts/perf-gate.ts reads
      // alongside First Contentful Paint to check the gate.
      performance.mark("webpic:first-frame");
      options.onFirstFrame?.();
    } else if (message.kind === "error") {
      console.error("[render worker]", message.message);
    }
  };

  const request: RenderWorkerRequest = {
    kind: "init",
    requestId: INIT_REQUEST_ID,
    canvas: offscreen,
    width,
    height,
  };
  worker.postMessage(request, [offscreen]); // transfer the OffscreenCanvas

  store.getState().setDataset(options.dataset ?? createSyntheticDataset());

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
    layerSync.dispose();
    unsubscribeWindow();
    unsubscribePose();
    worker.terminate();
  };
}
