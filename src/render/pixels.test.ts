import { describe, expect, it } from "vitest";
import { toTransferablePixels } from "./pixels.ts";

describe("toTransferablePixels", () => {
  it("returns an already-compact Uint8Array unchanged (no copy)", () => {
    const compact = new Uint8Array([1, 2, 3, 4]);
    const out = toTransferablePixels(compact);
    expect(out).toBe(compact);
    expect(out.byteOffset).toBe(0);
    expect(out.byteLength).toBe(out.buffer.byteLength);
  });

  it("copies an offset/oversized view so the whole buffer transfers cleanly", () => {
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = pool.subarray(2, 5); // byteOffset 2, length 3, buffer larger than view
    const out = toTransferablePixels(view);
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
    expect(out.byteOffset).toBe(0);
    expect(out.byteLength).toBe(out.buffer.byteLength);
  });

  it("normalizes a non-Uint8Array readback view by its byte range", () => {
    const f = new Float32Array([1, 2]); // 8 bytes, exact-fit buffer
    const out = toTransferablePixels(f);
    expect(out.byteLength).toBe(8);
    expect(out.byteOffset).toBe(0);
    expect(out.byteLength).toBe(out.buffer.byteLength);
  });
});
