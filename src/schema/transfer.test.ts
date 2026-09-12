import { describe, expect, it } from "vitest";
import { transferableBuffer } from "./transfer.ts";

describe("transferableBuffer", () => {
  it("returns the view's own backing buffer, not a copy", () => {
    const view = new Float32Array([1, 2, 3]);
    expect(transferableBuffer(view)).toBe(view.buffer);
  });

  it("returns the whole buffer behind a subarray, which is what postMessage transfers", () => {
    // A transfer list takes buffers, never views — a windowed view still hands over all of it.
    const view = new Float32Array(8).subarray(2, 4);
    expect(transferableBuffer(view).byteLength).toBe(32);
  });

  it("reports detachment after the buffer has been transferred away", () => {
    const view = new Uint8Array(4);
    const buffer = transferableBuffer(view);
    expect(buffer.detached).toBe(false);
    buffer.transfer();
    expect(buffer.detached).toBe(true);
  });
});
