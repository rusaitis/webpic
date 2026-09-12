import { transferableBuffer } from "@schema/transfer.ts";
import type { RenderWorkerRequest, RenderWorkerResponse } from "../messages.ts";
import type { CompositeDrawItem, InstalledRenderer } from "./renderer.ts";
import { pixelsToPngBlob } from "./screenshot.ts";

// Deterministic readbacks: render the composite to the offscreen target, await the GPU, post the
// pixels — never render-scaled, immune to swapchain-present timing. That await is the only async gap
// in the worker's single thread, so the display loop's swapchain render is paused across it: a rAF
// frame between the readback render and its await would corrupt the read pixels.
export interface ReadbackHost {
  // The live renderer; undefined pre-init / post-dispose (the request then fails loudly).
  renderer(): InstalledRenderer | undefined;
  // What the next paint draws, freshly allocated — the paint scratch would mutate under the await.
  paintItems(): CompositeDrawItem[];
  // Pause / resume the display loop around the borrowed renderer (resume re-dirties).
  beginReadback(): void;
  endReadback(): void;
  post(
    message: Extract<RenderWorkerResponse, { kind: "frame" | "screenshot" }>,
    transfer?: Transferable[],
  ): void;
}

export interface Readback {
  // Raw RGBA8 pixels, transferred.
  frame(request: Extract<RenderWorkerRequest, { kind: "renderFrame" }>): Promise<void>;
  // The same readback PNG-encoded worker-side.
  screenshot(request: Extract<RenderWorkerRequest, { kind: "screenshot" }>): Promise<void>;
}

export function createReadback(host: ReadbackHost): Readback {
  function liveRenderer(kind: "renderFrame" | "screenshot"): InstalledRenderer {
    const renderer = host.renderer();
    if (renderer === undefined) throw new Error(`${kind} before init`);
    return renderer;
  }

  return {
    async frame(request) {
      const renderer = liveRenderer(request.kind);
      const items = host.paintItems();
      host.beginReadback();
      try {
        const pixels = await renderer.readCompositePixels(items);
        // The readback target's physical size (logical × DPR) — the dimensions the buffer actually
        // holds; the worker's logical dims disagree at DPR ≠ 1.
        const size = renderer.readbackSize();
        const buffer = transferableBuffer(pixels);
        host.post(
          {
            kind: "frame",
            requestId: request.requestId,
            width: size.width,
            height: size.height,
            pixels: buffer,
          },
          [buffer],
        );
      } finally {
        host.endReadback(); // re-dirty so the swapchain the readback borrowed repaints
      }
    },

    // The failure arm posts blob:null so the app's pending state never strands (layerCompiled's
    // never-strand contract); the rethrow still surfaces the message on the error channel.
    async screenshot(request) {
      const renderer = liveRenderer(request.kind);
      try {
        let pixels: Uint8Array;
        host.beginReadback();
        try {
          pixels = await renderer.readCompositePixels(host.paintItems());
        } finally {
          host.endReadback();
        }
        const { width, height } = renderer.readbackSize();
        const blob = await pixelsToPngBlob(pixels, width, height);
        host.post({ kind: "screenshot", requestId: request.requestId, blob, width, height });
      } catch (error) {
        host.post({
          kind: "screenshot",
          requestId: request.requestId,
          blob: null,
          width: 0,
          height: 0,
        });
        throw error;
      }
    },
  };
}
