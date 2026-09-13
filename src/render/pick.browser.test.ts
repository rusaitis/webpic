// Real-worker round-trip for pick-to-focus: init + upsertLayer (off-center ball) + pickRay through
// the live volume camera. This is the only automated check of the unproject/NDC conventions against
// the real camera matrices (the pure march is covered in pickRay.test.ts). Runs in the headed-Chrome
// `gpu` vitest project (`npm run test:gpu`) — local-only, not CI.

import { describe, expect, it } from "vitest";
import { ballField } from "../../tests/fixtures.ts";
import type { RenderWorkerRequest, RenderWorkerResponse } from "./messages.ts";

const SIZE = 64;
const N = 16;

// Offset along object-x = field axis 0 (slowest), so a transposed upload or a wrong NDC basis pulls
// the pick back to the box center and fails loudly.
const OFFSET_BALL = ballField([0.25, 0, 0], 0.15, N);

// Level straight-on view down −x: the centered ray runs through the box center AND the ball.
const POSE = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 2, roll: 0 } as const;

function pickPoints(): Promise<{ persp: readonly number[]; ortho: readonly number[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const post = (message: RenderWorkerRequest): void => worker.postMessage(message);
    const pick = (requestId: number): void =>
      post({ kind: "pickRay", requestId, ndcX: 0, ndcY: 0, purpose: "focus" });
    let phase: "persp" | "ortho" = "persp";
    let perspPoint: readonly number[] | undefined;
    let retries = 40; // ~2 s cap — the upsert's async pipeline warm commits after the first picks
    const fail = (message: string): void => {
      worker.terminate();
      reject(new Error(message));
    };
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the branches are the response kinds this probe answers, in the order the worker sends them
    worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
      const message = event.data;
      switch (message.kind) {
        case "ready": {
          const data = OFFSET_BALL.data;
          // Float32Array allocates a plain ArrayBuffer; the payload type narrows ArrayBufferLike.
          const buffer = data.buffer as ArrayBuffer;
          worker.postMessage(
            {
              kind: "upsertLayer",
              requestId: 2,
              id: "vol",
              field: { buffer, dtype: "f32", shape: [N, N, N] },
              colormap: "inferno",
              scale: "linear",
              opacity: 1,
              windowLevel: { center: 0.5, width: 1 },
              params: { layerKind: "volume", density: 4 },
            } satisfies RenderWorkerRequest,
            [buffer],
          );
          post({
            kind: "setLayerOrder",
            requestId: 3,
            order: [{ id: "vol", visible: true, opacity: 1 }],
          });
          post({ kind: "setCameraPose", requestId: 4, pose: POSE });
          pick(5);
          return;
        }
        case "pickResult": {
          const point = message.point;
          if (phase === "persp") {
            // Until the layer's warm-then-commit lands, the pick sees no fields and answers the
            // chord midpoint (x ≈ 0) — poll until the ball shows up or retries run out.
            if ((point === null || Math.abs(point[0]) < 0.05) && retries > 0) {
              retries -= 1;
              setTimeout(() => pick(5), 50);
              return;
            }
            if (point === null) {
              fail("perspective pick missed the box");
              return;
            }
            perspPoint = point;
            phase = "ortho";
            post({ kind: "setProjection", requestId: 6, projection: "orthographic" });
            pick(7);
            return;
          }
          worker.terminate();
          if (point === null) {
            reject(new Error("orthographic pick missed the box"));
            return;
          }
          if (perspPoint === undefined) {
            reject(new Error("ortho result before the perspective one"));
            return;
          }
          resolve({ persp: perspPoint, ortho: point });
          return;
        }
        case "frame":
        case "frameTiming":
        case "perfSample":
        case "layerCompiled":
        case "screenshot":
        case "disposed":
          return;
        case "error":
        case "gpuRecoveryFailed":
          fail(message.message);
          return;
        default: {
          const unreachable: never = message;
          reject(new Error(`unexpected response: ${JSON.stringify(unreachable)}`));
        }
      }
    };
    worker.postMessage(
      {
        kind: "init",
        requestId: 1,
        canvas,
        width: SIZE,
        height: SIZE,
        devicePixelRatio: 1,
      } satisfies RenderWorkerRequest,
      [canvas],
    );
  });
}

describe("worker pickRay", () => {
  it("picks the off-center ball through the live camera, perspective and ortho alike", async () => {
    const { persp, ortho } = await pickPoints();
    // The median-depth point lands inside the ball (x ≈ 0.25 ± its radius), on the ray axis.
    expect(persp[0]).toBeGreaterThan(0.08);
    expect(persp[0]).toBeLessThan(0.42);
    expect(Math.abs(persp[1] ?? 1)).toBeLessThan(0.05);
    expect(Math.abs(persp[2] ?? 1)).toBeLessThan(0.05);
    // The centered ortho ray is the same line — the pick must agree.
    expect(Math.abs((ortho[0] ?? 1) - (persp[0] ?? 0))).toBeLessThan(0.1);
    expect(Math.abs(ortho[1] ?? 1)).toBeLessThan(0.05);
    expect(Math.abs(ortho[2] ?? 1)).toBeLessThan(0.05);
  });
});
