import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { createSimulationStore, createUiStore } from "@store";
import { installUi } from "@ui";
import { createSyntheticDataset } from "./syntheticDataset.ts";

const DEFAULT_SIZE = 256;
const INIT_REQUEST_ID = 1;
const SLICE_REQUEST_ID = 2;

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

  // Serialize the computed field and hand it to the worker by transfer (never clone a large
  // typed array). The magnitude is freshly allocated, so its buffer is offset-0 and an
  // ArrayBuffer (not the SharedArrayBuffer that ArrayBufferLike also admits).
  const forwardSlice = (field: FieldArray): void => {
    const dtype = field.data instanceof Float64Array ? "f64" : "f32";
    const buffer = field.data.buffer as ArrayBuffer;
    const { windowLevel } = store.getState();
    const request: RenderWorkerRequest = {
      kind: "showSlice",
      requestId: SLICE_REQUEST_ID,
      field: { buffer, dtype, shape: field.shape },
      axis: "z",
      position: 0.5,
      colormap: "inferno",
      ...(windowLevel !== null ? { windowLevel } : {}),
    };
    worker.postMessage(request, [buffer]);
  };

  // Subscribe before dispatching so the first compute is never missed; gate on the worker
  // being ready (covers the compute-finishes-after-ready ordering, e.g. a later selectField).
  const unsubscribe = store.subscribe(
    (state) => state.computed,
    (computed) => {
      if (workerReady && computed !== null) forwardSlice(computed);
    },
  );

  // Window/level changes ride a cheap message (no field transfer) — the drag hot path is just
  // a uniform retune + repaint. A field switch fires both this and `computed`; the resulting
  // setWindowLevel is a redundant no-op over the freshly-built scene.
  const unsubscribeWindow = store.subscribe(
    (state) => state.windowLevel,
    (windowLevel) => {
      if (workerReady && windowLevel !== null) {
        const request: RenderWorkerRequest = {
          kind: "setWindowLevel",
          requestId: SLICE_REQUEST_ID,
          windowLevel,
        };
        worker.postMessage(request);
      }
    },
  );

  worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
    const message = event.data;
    if (message.kind === "ready") {
      workerReady = true;
      // The compute typically finished before init; show it now that the renderer is live.
      const { computed } = store.getState();
      if (computed !== null) forwardSlice(computed);
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
    unsubscribe();
    unsubscribeWindow();
    worker.terminate();
  };
}
