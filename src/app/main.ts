import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";

const DEFAULT_SIZE = 256;

// Seams default to the real DOM/Worker; the handshake test injects fakes so
// bootstrap runs headless in Node.
export interface BootstrapOptions {
  readonly width?: number;
  readonly height?: number;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly mount?: (canvas: HTMLCanvasElement) => void;
  readonly spawnWorker?: () => Worker;
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
  worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
    const message = event.data;
    if (message.kind === "ready") {
      // First GPU frame is up. The mark's startTime is ms since navigation, which
      // scripts/perf-gate.ts reads alongside First Contentful Paint to check the gate.
      performance.mark("webpic:first-frame");
      options.onFirstFrame?.();
    } else if (message.kind === "error") {
      console.error("[render worker]", message.message);
    }
  };

  const request: RenderWorkerRequest = {
    kind: "init",
    requestId: 1,
    canvas: offscreen,
    width,
    height,
  };
  worker.postMessage(request, [offscreen]); // transfer the OffscreenCanvas

  return () => worker.terminate();
}
