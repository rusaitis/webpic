import type { RenderWorkerRequest } from "@render";
import { describe, expect, it } from "vitest";
import { bootstrap } from "./main.ts";

interface Post {
  readonly message: RenderWorkerRequest;
  readonly transfer: Transferable[] | undefined;
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
