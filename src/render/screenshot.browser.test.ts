// Real-WebGPU screenshot: the worker's PNG capture must decode back to the readback's
// dimensions with representative content. Skipped wherever WebGPU/Worker/OffscreenCanvas are
// absent (the Node PR gate skips it green); runs under `npm run test:gpu`.

import { describe, expect, it } from "vitest";
import type { RenderWorkerRequest, RenderWorkerResponse } from "./messages.ts";

const SIZE = 64;

type ScreenshotReply = Extract<RenderWorkerResponse, { kind: "screenshot" }>;

function workerScreenshot(): Promise<ScreenshotReply> {
  return new Promise<ScreenshotReply>((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
      const message = event.data;
      switch (message.kind) {
        case "ready": {
          const request: RenderWorkerRequest = { kind: "screenshot", requestId: 15 };
          worker.postMessage(request);
          return;
        }
        case "screenshot":
          worker.terminate();
          resolve(message);
          return;
        case "frame":
        case "frameTiming":
        case "perfSample":
        case "pickResult":
        case "layerCompiled":
          return;
        case "error":
        case "gpuRecoveryFailed":
          worker.terminate();
          reject(new Error(message.message));
          return;
        case "disposed":
          return;
        default: {
          const unreachable: never = message;
          reject(new Error(`unexpected response: ${JSON.stringify(unreachable)}`));
        }
      }
    };
    const init: RenderWorkerRequest = {
      kind: "init",
      requestId: 1,
      canvas,
      width: SIZE,
      height: SIZE,
      devicePixelRatio: 1,
      debugScene: true, // the RGB triangle gives the capture non-uniform, checkable content
    };
    worker.postMessage(init, [canvas]);
  });
}

describe("worker PNG screenshot", () => {
  it("captures the composite as a decodable, opaque PNG at readback size", async () => {
    const shot = await workerScreenshot();
    expect(shot.blob).not.toBeNull();
    if (shot.blob === null) throw new Error("unreachable");
    expect(shot.blob.type).toBe("image/png");
    expect(shot.width).toBe(SIZE);
    expect(shot.height).toBe(SIZE);

    const bitmap = await createImageBitmap(shot.blob);
    expect(bitmap.width).toBe(SIZE);
    expect(bitmap.height).toBe(SIZE);

    const probe = new OffscreenCanvas(SIZE, SIZE);
    const context = probe.getContext("2d");
    if (context === null) throw new Error("2d context unavailable");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, SIZE, SIZE);

    let distinctFromFirst = 0;
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i + 3]).toBe(255); // every pixel opaque (alpha forced on encode)
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) {
        distinctFromFirst += 1;
      }
    }
    // The triangle covers part of the frame — a uniform capture means a blank/failed readback.
    expect(distinctFromFirst).toBeGreaterThan(0);
  });
});
