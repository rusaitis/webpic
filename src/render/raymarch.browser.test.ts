// Real-WebGPU smoke: a centered high-value blob must accumulate into a bright core where the
// box projects (frame center) and leave the corners at the cleared background. Asserts
// color-space-agnostic luminance relations (center ≫ corner) so it holds whether the runner
// reads back linear or sRGB bytes, and exercises the analytic ray-box + early-α compositing
// end-to-end. Skipped wherever WebGPU is absent (Node PR gate skips green); the runner imports
// `three/webgpu` dynamically so Node never loads it.

import { describe, expect, it } from "vitest";
import type { ScalarField } from "./volumeTexture.ts";

const hasRealGpu =
  typeof navigator !== "undefined" && "gpu" in navigator && typeof OffscreenCanvas !== "undefined";

const SIZE = 32;

// A radial blob peaked at the volume center, falling to zero by r = 0.4 (normalized).
function blobField(): ScalarField {
  const n = 16;
  const data = new Float32Array(n * n * n);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5) / n - 0.5;
        const dy = (y + 0.5) / n - 0.5;
        const dz = (z + 0.5) / n - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        data[x + n * (y + n * z)] = Math.max(0, 1 - r / 0.4);
      }
    }
  }
  return { data, shape: [n, n, n] };
}

async function renderVolumePixels(): Promise<Uint8Array> {
  const { installRenderer } = await import("./renderer.ts");
  const { createRaymarchScene } = await import("./raymarchScene.ts");
  const renderer = await installRenderer({
    canvas: new OffscreenCanvas(SIZE, SIZE),
    width: SIZE,
    height: SIZE,
  });
  const volume = createRaymarchScene({ field: blobField(), colormap: "inferno", density: 4 });
  try {
    return await renderer.readPixels(volume.scene, volume.camera);
  } finally {
    volume.dispose();
    renderer.dispose();
  }
}

describe("raymarch scene render", () => {
  it.skipIf(!hasRealGpu)("accumulates a bright core where the box projects", async () => {
    const px = await renderVolumePixels();
    const at = (col: number, row: number): readonly [number, number, number] => {
      const i = (row * SIZE + col) * 4;
      return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
    };
    const lum = ([r, g, b]: readonly [number, number, number]): number =>
      0.2126 * r + 0.7152 * g + 0.0722 * b;

    const center = at(SIZE >> 1, SIZE >> 1);
    const corner = at(0, 0);

    // The blob accumulates inferno color at the center; the corner stays at the dark background.
    expect(lum(center)).toBeGreaterThan(lum(corner) + 20);
    // Non-background core (background 0x101820 ⇒ luminance ≈ 23).
    expect(lum(center)).toBeGreaterThan(50);
    // inferno warm core: red dominates blue (a transposed/greyscale path would fail this).
    expect(center[0]).toBeGreaterThan(center[2]);
  });
});
