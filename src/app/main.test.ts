import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { fieldInfo } from "@schema/registry.ts";
import { describe, expect, it } from "vitest";
import { bootstrap } from "./main.ts";

interface Post {
  readonly message: RenderWorkerRequest;
  readonly transfer: Transferable[] | undefined;
}

const DUMMY_GRID: GridInfo = {
  dimensions: [1, 1, 1],
  spacing: [1, 1, 1],
  origin: [0, 0, 0],
  geometry: "cartesian",
  axisLabels: ["x", "y", "z"],
  dt: null,
  boundary: null,
  survivingAxes: null,
  stagger: null,
};

// Single-cell B = (3, 4, 0) so |B| = 5 — a deterministic stand-in for the synthetic scaffold.
function tinyDataset(): FieldDataset {
  const component = (name: string, value: number): FieldArray => {
    const meta = fieldInfo(name);
    return {
      data: new Float32Array([value]),
      shape: [1, 1, 1],
      meta,
      units: meta.siUnit,
      latex: meta.latex,
      reduction: null,
    };
  };
  return {
    fields: new Map([
      ["B_1", component("B_1", 3)],
      ["B_2", component("B_2", 4)],
      ["B_3", component("B_3", 0)],
    ]),
    grid: DUMMY_GRID,
    normalization: {
      lengthRef: 1,
      timeRef: 1,
      velocityRef: 1,
      bFieldRef: 1,
      eFieldRef: 1,
      densityRef: 1,
      massRef: 1,
      chargeRef: 1,
      speedOfLight: Number.POSITIVE_INFINITY,
    },
    species: [],
    physics: { gamma: 1, c: Number.POSITIVE_INFINITY, relativistic: false, extra: {} },
    frame: "lab",
    transforms: {},
    metadata: {},
    step: 0,
  };
}

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
  it("computes |B| and posts a showSlice carrying the field once the worker is ready", () => {
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

    const slice = posts.find((p) => p.message.kind === "showSlice");
    if (slice === undefined || slice.message.kind !== "showSlice") {
      throw new Error("expected a showSlice message");
    }
    expect(slice.message.field.dtype).toBe("f32");
    expect(slice.message.field.shape).toEqual([1, 1, 1]);
    expect(Array.from(new Float32Array(slice.message.field.buffer))).toEqual([5]);
    // The field buffer is transferred, not cloned.
    expect(slice.transfer).toEqual([slice.message.field.buffer]);

    dispose();
  });
});
