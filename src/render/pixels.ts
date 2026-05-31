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
