import { toOpaqueImageBytes } from "./pixels.ts";

// PNG encode via a 2D OffscreenCanvas — the worker-side equivalent of canvas.toBlob('image/png').
// The readback rows are top-left-origin (WebGPU render-target convention), matching ImageData
// directly; no flip. Worker/browser-only (OffscreenCanvas), so it lives beside renderer.ts and
// stays out of the Node-testable pixels.ts.

export async function pixelsToPngBlob(
  pixels: Uint8Array,
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("screenshot: 2d canvas context unavailable");
  context.putImageData(new ImageData(toOpaqueImageBytes(pixels), width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}
