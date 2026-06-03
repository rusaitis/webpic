// Real-WebGPU parity: a worker-rendered frame must match the main-thread frame
// within 1 px per channel — the regression catch for r179-style OffscreenCanvas
// breakage in Three.js. Skipped wherever WebGPU/Worker/OffscreenCanvas are absent
// (the Node PR gate skips it green); runs on a real-GPU runner. Renderer/scene are
// imported dynamically inside the test bodies so `three/webgpu` never loads in Node.

import { describe, expect, it } from "vitest";
import type { RenderWorkerRequest, RenderWorkerResponse } from "./messages.ts";

const hasRealGpu =
  typeof navigator !== "undefined" &&
  "gpu" in navigator &&
  typeof Worker !== "undefined" &&
  typeof OffscreenCanvas !== "undefined";

const SIZE = 64;

async function mainThreadPixels(): Promise<Uint8Array> {
  const { installRenderer } = await import("./renderer.ts");
  const { createTestScene } = await import("./scene.ts");
  const { createOrthographicCamera } = await import("./camera.ts");
  const renderer = await installRenderer({
    canvas: new OffscreenCanvas(SIZE, SIZE),
    width: SIZE,
    height: SIZE,
  });
  const scene = createTestScene();
  // Must match the worker's boot-frame camera exactly — same factory, same FRUSTUM.
  const camera = createOrthographicCamera();
  try {
    return await renderer.readPixels(scene.scene, camera);
  } finally {
    scene.dispose();
    renderer.dispose();
  }
}

function workerPixels(): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
      const message = event.data;
      switch (message.kind) {
        case "ready": {
          const frame: RenderWorkerRequest = { kind: "renderFrame", requestId: 2 };
          worker.postMessage(frame);
          return;
        }
        case "frame":
          worker.terminate();
          resolve(new Uint8Array(message.pixels));
          return;
        case "error":
          worker.terminate();
          reject(new Error(message.message));
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
    };
    worker.postMessage(init, [canvas]);
  });
}

describe("worker vs main frame parity", () => {
  // Skipped on the Node PR gate (no real WebGPU); runs on a real-GPU runner.
  it.skipIf(!hasRealGpu)(
    "worker frame matches the main-thread frame within 1 px/channel",
    async () => {
      const [main, worker] = await Promise.all([mainThreadPixels(), workerPixels()]);
      expect(worker.length).toBe(main.length);
      let maxDelta = 0;
      for (let i = 0; i < main.length; i += 1) {
        maxDelta = Math.max(maxDelta, Math.abs((main[i] ?? 0) - (worker[i] ?? 0)));
      }
      expect(maxDelta).toBeLessThanOrEqual(1);
    },
  );
});
