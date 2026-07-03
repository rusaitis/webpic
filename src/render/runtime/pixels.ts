// Pure pixel-buffer helpers, deliberately free of three/webgpu so they unit-test in
// Node (renderer.ts can't be imported there — it pulls in the WebGPU renderer).

/**
 * Normalize a GPU readback result to a standalone, exactly-sized Uint8Array safe to
 * transfer wholesale via `postMessage(buf, [buf.buffer])`. A view with a nonzero
 * `byteOffset`, or a backing buffer larger than the logical pixels, would otherwise
 * ship the wrong bytes — the receiver reconstructs from offset 0 over the full buffer.
 * Copies only when the input isn't already compact (the common case is a no-op).
 */
export function toTransferablePixels(data: ArrayBufferView): Uint8Array {
  const u8 =
    data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice();
}

/**
 * RGBA readback → ImageData bytes: copy + force alpha to 255. The composite's blend math can
 * leave sub-255 alpha on translucent layers even over the opaque clear, and a PNG carrying it
 * would re-blend against whatever background displays it. A screenshot is what-you-see → opaque.
 */
export function toOpaqueImageBytes(pixels: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  // Fresh allocation (never mutate the readback in place); length-constructed so the backing
  // buffer is a plain ArrayBuffer — ImageData rejects a potentially-shared one.
  const out = new Uint8ClampedArray(pixels.length);
  out.set(pixels);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

/**
 * Strip WebGPU copy padding from a readback. Three r184's `copyTextureToBuffer` pads
 * `bytesPerRow` to the mandatory 256-byte alignment but returns the mapped buffer verbatim,
 * so any readback whose width × 4 isn't a 256 multiple arrives with garbage between rows
 * (`readRenderTargetPixelsAsync` passes it straight through). Length-guarded: input that is
 * already tight — aligned widths today, or a fixed upstream tomorrow — passes through untouched.
 */
export function compactPaddedRows(
  data: ArrayBufferView,
  width: number,
  height: number,
  bytesPerTexel = 4,
): Uint8Array {
  const u8 =
    data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const rowBytes = width * bytesPerTexel;
  const paddedRowBytes = Math.ceil(rowBytes / 256) * 256;
  const paddedLength = (height - 1) * paddedRowBytes + rowBytes;
  // Tight and padded layouts coincide for aligned widths and single rows — nothing to strip.
  if (u8.byteLength !== paddedLength || paddedLength === rowBytes * height) return u8;
  const out = new Uint8Array(rowBytes * height);
  for (let row = 0; row < height; row++) {
    out.set(u8.subarray(row * paddedRowBytes, row * paddedRowBytes + rowBytes), row * rowBytes);
  }
  return out;
}
