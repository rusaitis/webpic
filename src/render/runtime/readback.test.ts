import { describe, expect, it, vi } from "vitest";
import { createReadback } from "./readback.ts";
import type { InstalledRenderer } from "./renderer.ts";

// The readback contract without a GPU: the loop is paused exactly across the awaited read, the
// frame's pixels transfer, the screenshot's failure arm never strands the app, and a pre-init
// request fails loudly. pixelsToPngBlob needs OffscreenCanvas, so it's mocked.

const png = new Blob(["png"], { type: "image/png" });
vi.mock("./screenshot.ts", () => ({ pixelsToPngBlob: vi.fn(async () => png) }));

function makeRig(options: { readonly renderer?: boolean; readonly fail?: boolean } = {}) {
  const log: string[] = [];
  const pixels = new Uint8Array([1, 2, 3, 4]);
  const renderer = {
    readCompositePixels: vi.fn(async () => {
      log.push("read");
      if (options.fail === true) throw new Error("device lost");
      return pixels;
    }),
    readbackSize: () => ({ width: 2, height: 1 }),
  };
  const post = vi.fn((message: { kind: string }, _transfer?: Transferable[]) => {
    log.push(`post:${message.kind}`);
  });
  // Only the two readback members are exercised, so the fake omits the rest of the renderer.
  const live = renderer as unknown as InstalledRenderer;
  const readback = createReadback({
    renderer: () => (options.renderer === false ? undefined : live),
    paintItems: () => [],
    beginReadback: () => {
      log.push("begin");
    },
    endReadback: () => {
      log.push("end");
    },
    post,
  });
  return { readback, log, post, pixels };
}

describe("createReadback", () => {
  it("frame: pauses the loop across the read, posts + transfers the pixels, then resumes", async () => {
    const rig = makeRig();
    await rig.readback.frame({ kind: "renderFrame", requestId: 3 });
    expect(rig.log).toEqual(["begin", "read", "post:frame", "end"]);
    const [message, transfer] = rig.post.mock.calls[0] ?? [];
    expect(message).toEqual({
      kind: "frame",
      requestId: 3,
      width: 2,
      height: 1,
      pixels: rig.pixels.buffer,
    });
    expect(transfer).toEqual([rig.pixels.buffer]);
  });

  it("frame: a failed read still resumes the loop and rejects", async () => {
    const rig = makeRig({ fail: true });
    await expect(rig.readback.frame({ kind: "renderFrame", requestId: 4 })).rejects.toThrow(
      "device lost",
    );
    expect(rig.log).toEqual(["begin", "read", "end"]);
    expect(rig.post).not.toHaveBeenCalled();
  });

  it("screenshot: pauses only across the read, encodes, then posts the blob", async () => {
    const rig = makeRig();
    await rig.readback.screenshot({ kind: "screenshot", requestId: 5 });
    expect(rig.log).toEqual(["begin", "read", "end", "post:screenshot"]);
    expect(rig.post).toHaveBeenCalledWith({
      kind: "screenshot",
      requestId: 5,
      blob: png,
      width: 2,
      height: 1,
    });
  });

  it("screenshot: a failure posts blob:null so the app never strands, then rethrows", async () => {
    const rig = makeRig({ fail: true });
    await expect(rig.readback.screenshot({ kind: "screenshot", requestId: 6 })).rejects.toThrow(
      "device lost",
    );
    expect(rig.log).toEqual(["begin", "read", "end", "post:screenshot"]);
    expect(rig.post).toHaveBeenCalledWith({
      kind: "screenshot",
      requestId: 6,
      blob: null,
      width: 0,
      height: 0,
    });
  });

  it("fails loudly before init without touching the loop", async () => {
    const rig = makeRig({ renderer: false });
    await expect(rig.readback.frame({ kind: "renderFrame", requestId: 7 })).rejects.toThrow(
      "renderFrame: renderer is not installed",
    );
    await expect(rig.readback.screenshot({ kind: "screenshot", requestId: 8 })).rejects.toThrow(
      "screenshot: renderer is not installed",
    );
    expect(rig.log).toEqual([]);
  });
});
