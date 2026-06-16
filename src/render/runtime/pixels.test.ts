import { describe, expect, it } from "vitest";
import { compactPaddedRows, toTransferablePixels } from "./pixels.ts";

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

describe("compactPaddedRows", () => {
  // Build a readback the way three r184's copyTextureToBuffer lays it out: each row padded to a
  // 256-byte stride except the last, which ends at the tight row width. Row r's pixels are filled
  // with the value r+1 so a compaction error (offset or interleave) changes the bytes.
  function paddedReadback(width: number, height: number): Uint8Array {
    const rowBytes = width * 4;
    const stride = Math.ceil(rowBytes / 256) * 256;
    const out = new Uint8Array((height - 1) * stride + rowBytes);
    for (let r = 0; r < height; r++) out.fill(r + 1, r * stride, r * stride + rowBytes);
    return out;
  }

  it("strips the 256-byte row padding from an unaligned-width readback", () => {
    const width = 32; // 128 bytes/row → padded to 256
    const height = 4;
    const out = compactPaddedRows(paddedReadback(width, height), width, height);
    expect(out.byteLength).toBe(width * 4 * height);
    for (let r = 0; r < height; r++) {
      expect(out[r * width * 4]).toBe(r + 1); // row start
      expect(out[(r + 1) * width * 4 - 1]).toBe(r + 1); // row end
    }
  });

  it("passes an aligned-width readback through untouched", () => {
    const width = 64; // 256 bytes/row — already tight
    const tight = paddedReadback(width, 3);
    expect(compactPaddedRows(tight, width, 3)).toBe(tight);
  });

  it("passes already-tight unaligned data through (a fixed upstream)", () => {
    const width = 32;
    const height = 4;
    const tight = new Uint8Array(width * 4 * height).fill(7);
    expect(compactPaddedRows(tight, width, height)).toBe(tight);
  });

  it("handles a single-row readback (no inter-row padding exists)", () => {
    const width = 32;
    const tight = new Uint8Array(width * 4).fill(3);
    expect(compactPaddedRows(tight, width, 1)).toBe(tight);
  });
});
