import type { FieldDataset } from "@containers/field_dataset.ts";
import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { createSimulationStore, createUiStore } from "@store";
import { installPointerCamera, installUi } from "@ui";
import { installLayerSync } from "./layerSync.ts";
import { createSyntheticDataset } from "./syntheticDataset.ts";

const DEFAULT_SIZE = 256;
const INIT_REQUEST_ID = 1;
const POSE_REQUEST_ID = 3;
const CONTINUOUS_REQUEST_ID = 4;
const RESIZE_REQUEST_ID = 5;
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

  // Logical (CSS) size from the mounted, full-viewport element; explicit options win for the
  // headless handshake test. The worker scales these by devicePixelRatio for the drawing buffer.
  const logicalSize = (): { width: number; height: number } => ({
    width: options.width ?? (canvas.clientWidth || DEFAULT_SIZE),
    height: options.height ?? (canvas.clientHeight || DEFAULT_SIZE),
  });
  const initial = logicalSize();

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

  // Viewport/DPR tracking. ResizeObserver is frame-aligned, so post directly (no extra debounce).
  // Guarded like installPointerCamera so the headless fake canvas (no addEventListener) is untouched.
  let disposeResize: (() => void) | undefined;
  if (typeof canvas.addEventListener === "function" && typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (!workerReady) return; // init carried the first layout; a pre-ready resize is vanishingly rare
      const size = logicalSize();
      worker.postMessage({
        kind: "resize",
        requestId: RESIZE_REQUEST_ID,
        width: size.width,
        height: size.height,
        devicePixelRatio: currentDevicePixelRatio(),
      } satisfies RenderWorkerRequest);
    });
    observer.observe(canvas);
    disposeResize = () => observer.disconnect();
  }

  worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
    const message = event.data;
    if (message.kind === "ready") {
      workerReady = true;
      // The compute typically finished before init; push the full layer state now that the
      // renderer is live (upsert each active-field layer + the composite).
      layerSync.flushAll();
      // Catch-up: the pose subscription drops posts while !workerReady, so replay the current pose
      // once — a drag during worker init updates the store + gnomon but would otherwise be lost.
      worker.postMessage({
        kind: "setCameraPose",
        requestId: POSE_REQUEST_ID,
        pose: store.getState().cameraPose,
      } satisfies RenderWorkerRequest);
      // The mark's startTime is ms since navigation, which scripts/perf-gate.ts reads
      // alongside First Contentful Paint to check the gate.
      performance.mark("webpic:first-frame");
      options.onFirstFrame?.();
    } else if (message.kind === "frameTiming") {
      store.getState().setFrameTiming(message.gpuTimeMs, message.clock);
    } else if (message.kind === "error") {
      console.error("[render worker]", message.message);
    } else if (message.kind === "gpuRecoveryFailed") {
      console.error(`[render worker] GPU unrecoverable (${message.reason}):`, message.message);
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

  const request: RenderWorkerRequest = {
    kind: "init",
    requestId: INIT_REQUEST_ID,
    canvas: offscreen,
    width: initial.width,
    height: initial.height,
    devicePixelRatio: currentDevicePixelRatio(),
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
    disposeResize?.();
    layerSync.dispose();
    unsubscribePose();
    unsubscribeContinuous();
    worker.terminate();
  };
}
