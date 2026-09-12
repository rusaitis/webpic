import { REQUEST_IDS, type RenderWorkerRequest } from "@render/messages.ts";
import type { RenderWorkerLink } from "./storeBridge.ts";

// Tracks the canvas viewport + device-pixel-ratio and posts `resize` to the render worker (app-only
// glue). transferControlToOffscreen() moves the drawing surface, but the <canvas> still lays out on
// the main thread, so the size + DPR are observed here. Gated on `workerReady`; the headless fake
// canvas (no addEventListener) installs nothing.

// Cap the drawing-buffer scale: a raymarcher's cost is per physical pixel, so honor Retina (2×) but
// don't quadruple the work on 3×+ panels. Touch devices (phones/tablets) are GPU-bound on the volume
// march yet pack high DPR into modest GPUs, so cap them lower — 1.5× still reads sharp at arm's length
// but cuts march fragments ~1.8× vs 2×. `(pointer: coarse)` = the primary input is touch; a
// trackpad-equipped iPad reports `fine` and keeps the full 2×.
const MAX_DEVICE_PIXEL_RATIO = 2;
const MAX_DEVICE_PIXEL_RATIO_TOUCH = 1.5;

export function currentDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const isTouch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const cap = isTouch ? MAX_DEVICE_PIXEL_RATIO_TOUCH : MAX_DEVICE_PIXEL_RATIO;
  return Math.max(1, Math.min(window.devicePixelRatio || 1, cap));
}

export interface ViewportTrackingOptions extends RenderWorkerLink {
  readonly canvas: HTMLCanvasElement;
  // Logical (CSS) size of the mounted canvas — the worker scales it by devicePixelRatio.
  readonly logicalSize: () => { width: number; height: number };
}

export function installViewportTracking(options: ViewportTrackingOptions): () => void {
  const { canvas, worker, isReady, logicalSize } = options;

  // ResizeObserver is frame-aligned, so post directly (no extra debounce). A pre-ready resize is
  // vanishingly rare (init carried the first layout), so it's dropped rather than queued.
  const postResize = (): void => {
    if (!isReady()) return;
    const size = logicalSize();
    worker.postMessage({
      kind: "resize",
      requestId: REQUEST_IDS.resize,
      width: size.width,
      height: size.height,
      devicePixelRatio: currentDevicePixelRatio(),
    } satisfies RenderWorkerRequest);
  };

  // The headless handshake test's fake canvas has no addEventListener — install nothing, return a
  // no-op disposer so bootstrap's teardown stays uniform.
  if (typeof canvas.addEventListener !== "function") return () => {};

  let disposeResize: (() => void) | undefined;
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(postResize);
    observer.observe(canvas);
    disposeResize = () => observer.disconnect();
  }

  // A monitor move can change devicePixelRatio with no CSS resize — the ResizeObserver never fires and
  // the drawing buffer keeps the stale scale. The standard self-re-arming matchMedia loop: each query
  // matches only the current DPR, so its one `change` means "DPR is now something else".
  let disposeDprWatch: (() => void) | undefined;
  if (typeof matchMedia === "function") {
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

  return () => {
    disposeResize?.();
    disposeDprWatch?.();
  };
}
