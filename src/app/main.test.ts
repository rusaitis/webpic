import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { DEFAULT_POSE } from "@store";
import { describe, expect, it } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { bootstrap } from "./main.ts";

interface Post {
  readonly message: RenderWorkerRequest;
  readonly transfer: Transferable[] | undefined;
}

// Single-cell B = (3, 4, 0) so |B| = 5; f32 so the upsertLayer payload keeps the f32 dtype.
const tinyDataset = () => vectorTriple("B", { array: Float32Array, dims: [1, 1, 1] });

describe("bootstrap OffscreenCanvas handshake", () => {
  it("transfers the OffscreenCanvas to the worker inside an init message", () => {
    // Sentinel objects identity-checked below: the same reference appearing in the
    // message and the transfer list proves the canvas is transferred, not cloned.
    const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
    const canvas = {
      width: 0,
      height: 0,
      transferControlToOffscreen: () => offscreen,
    } as unknown as HTMLCanvasElement;

    const posts: Post[] = [];
    let terminated = 0;
    const worker = {
      onmessage: null,
      postMessage: (message: RenderWorkerRequest, transfer?: Transferable[]) => {
        posts.push({ message, transfer });
      },
      terminate: () => {
        terminated += 1;
      },
    } as unknown as Worker;

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
    });

    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (post === undefined) throw new Error("no message posted");
    expect(post.message.kind).toBe("init");
    if (post.message.kind !== "init") throw new Error("expected init message");
    expect(post.message.canvas).toBe(offscreen);
    expect(post.message.width).toBe(64);
    expect(post.message.height).toBe(48);
    expect(post.transfer).toEqual([offscreen]);

    dispose();
    expect(terminated).toBe(1);
  });
});

describe("bootstrap store → compute → render", () => {
  it("computes |B| and posts an upsertLayer + setComposite once the worker is ready", () => {
    const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
    const canvas = {
      width: 0,
      height: 0,
      transferControlToOffscreen: () => offscreen,
    } as unknown as HTMLCanvasElement;

    const posts: Post[] = [];
    const worker = {
      onmessage: null,
      postMessage: (message: RenderWorkerRequest, transfer?: Transferable[]) => {
        posts.push({ message, transfer });
      },
      terminate: () => {},
    } as unknown as Worker;

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
      dataset: tinyDataset(),
    });

    // Compute runs eagerly, but nothing is shown until the worker reports ready.
    expect(posts.map((p) => p.message.kind)).toEqual(["init"]);

    const ready = { data: { kind: "ready", requestId: 1 } } as MessageEvent<RenderWorkerResponse>;
    worker.onmessage?.(ready);

    // The auto-seeded layer is a volume; its field rides an upsertLayer (buffer transferred).
    const upsert = posts.find((p) => p.message.kind === "upsertLayer");
    if (upsert === undefined || upsert.message.kind !== "upsertLayer") {
      throw new Error("expected an upsertLayer message");
    }
    expect(upsert.message.layerKind).toBe("volume");
    expect(upsert.message.field.dtype).toBe("f32");
    expect(upsert.message.field.shape).toEqual([1, 1, 1]);
    expect(Array.from(new Float32Array(upsert.message.field.buffer))).toEqual([5]);
    // The field buffer is transferred, not cloned.
    expect(upsert.transfer).toEqual([upsert.message.field.buffer]);

    // The composite carries the one visible, full-opacity layer in draw order.
    const composite = posts.find((p) => p.message.kind === "setComposite");
    if (composite === undefined || composite.message.kind !== "setComposite") {
      throw new Error("expected a setComposite message");
    }
    expect(composite.message.order).toEqual([{ id: upsert.message.id, visible: true, opacity: 1 }]);

    dispose();
  });

  it("carries devicePixelRatio in the init message so the worker can size the drawing buffer", () => {
    const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
    const canvas = {
      width: 0,
      height: 0,
      transferControlToOffscreen: () => offscreen,
    } as unknown as HTMLCanvasElement;

    const posts: Post[] = [];
    const worker = {
      onmessage: null,
      postMessage: (message: RenderWorkerRequest, transfer?: Transferable[]) => {
        posts.push({ message, transfer });
      },
      terminate: () => {},
    } as unknown as Worker;

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
    });

    const init = posts[0];
    if (init === undefined || init.message.kind !== "init")
      throw new Error("expected init message");
    expect(init.message.devicePixelRatio).toBeGreaterThanOrEqual(1);

    dispose();
  });

  it("replays the camera pose on ready so a drag during worker init isn't dropped", () => {
    const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
    const canvas = {
      width: 0,
      height: 0,
      transferControlToOffscreen: () => offscreen,
    } as unknown as HTMLCanvasElement;

    const posts: Post[] = [];
    const worker = {
      onmessage: null,
      postMessage: (message: RenderWorkerRequest, transfer?: Transferable[]) => {
        posts.push({ message, transfer });
      },
      terminate: () => {},
    } as unknown as Worker;

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
      dataset: tinyDataset(),
    });

    // The pose subscription drops posts pre-ready; the ready handler must replay the live store pose.
    const ready = { data: { kind: "ready", requestId: 1 } } as MessageEvent<RenderWorkerResponse>;
    worker.onmessage?.(ready);

    const posePost = posts.find((p) => p.message.kind === "setCameraPose");
    if (posePost === undefined || posePost.message.kind !== "setCameraPose") {
      throw new Error("expected a setCameraPose catch-up on ready");
    }
    expect(posePost.message.pose).toEqual(DEFAULT_POSE);

    dispose();
  });
});
