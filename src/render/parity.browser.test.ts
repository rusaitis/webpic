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
  const { createOrthographicCamera } = await import("./camera/camera.ts");
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
        case "frameTiming":
        case "pickResult":
          return; // telemetry / unrequested replies — the deterministic readback is the `frame` reply
        case "error":
        case "gpuRecoveryFailed":
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
      devicePixelRatio: 1, // parity reads back at logical resolution — no DPR scaling
      debugScene: true, // the triangle is the parity target; default empty frames are clear-only
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

// Drive the *live swapchain present* path the readback parity test never touches: enter continuous
// mode (so the rAF loop renders + times every frame to the swapchain), stream camera-pose updates as
// an orbit would, and watch the frameTiming stream. The regression this guards: per-frame GPU work
// losing the device after the first frame (the loop emitted one frame then froze). A healthy loop
// keeps emitting frameTiming and never posts an error.
function workerSustainsSwapchain(): Promise<{ frames: number; errors: string[] }> {
  return new Promise<{ frames: number; errors: string[] }>((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    let frames = 0;
    const errors: string[] = [];
    const poses = [
      { target: [0, 0, 0], azimuth: 0.4, elevation: 0.3, distance: 2.4 },
      { target: [0, 0, 0], azimuth: 1.2, elevation: 0.6, distance: 2.2 },
      { target: [0, 0, 0], azimuth: 2.0, elevation: 0.2, distance: 2.6 },
    ] as const;
    worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
      const message = event.data;
      switch (message.kind) {
        case "ready": {
          worker.postMessage({
            kind: "setContinuous",
            requestId: 2,
            continuous: true,
          } satisfies RenderWorkerRequest);
          poses.forEach((pose, i) => {
            worker.postMessage({
              kind: "setCameraPose",
              requestId: 10 + i,
              pose,
            } satisfies RenderWorkerRequest);
          });
          // ~30 frames at 60 Hz; then assess that the loop kept producing them.
          setTimeout(() => {
            worker.terminate();
            resolve({ frames, errors });
          }, 500);
          return;
        }
        case "frameTiming":
          frames += 1;
          return;
        case "frame":
        case "pickResult":
          return;
        case "error":
        case "gpuRecoveryFailed":
          errors.push(message.message);
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
      debugScene: true, // keep a real draw call per frame — a clear-only loop wouldn't stress the GPU
    };
    worker.postMessage(init, [canvas]);
  });
}

describe("worker swapchain present loop", () => {
  it.skipIf(!hasRealGpu)(
    "sustains rendering under streamed pose updates without losing the device",
    async () => {
      const { frames, errors } = await workerSustainsSwapchain();
      expect(errors).toEqual([]); // no device-lost / validation error on the present pass
      expect(frames).toBeGreaterThan(5); // the loop kept rendering past frame 1
    },
  );
});
