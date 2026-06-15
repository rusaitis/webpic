// Real-WebGPU smoke for the layer compositor: two volume layers sharing one perspective camera
// (the coherent multi-layer case) must blend by draw order + per-layer opacity. Uses the
// deterministic readback primitive (readCompositePixels) — no swapchain present. Asserts
// color-space-agnostic relations so it holds whether bytes read back linear or sRGB. Skipped
// wherever WebGPU is absent (Node PR gate skips green); `three/webgpu` imported dynamically.

import { describe, expect, it } from "vitest";
import type { ScalarField } from "./volume/volumeTexture.ts";

const hasRealGpu =
  typeof navigator !== "undefined" && "gpu" in navigator && typeof OffscreenCanvas !== "undefined";

const SIZE = 32;

// Pinned box-centered pose, not DEFAULT_POSE: the tests read the center pixel, and the app
// default offsets its target for screen composition.
const CENTERED_POSE = {
  target: [0, 0, 0],
  azimuth: Math.PI / 4,
  elevation: 0.4773,
  distance: 2.3937,
} as const;

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

const lum = ([r, g, b]: readonly [number, number, number]): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

function pixelAt(px: Uint8Array, col: number, row: number): readonly [number, number, number] {
  const i = (row * SIZE + col) * 4;
  return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
}

// Manhattan channel distance — a color-space-agnostic "how different are these pixels".
function dist(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

describe("layer compositor", () => {
  it.skipIf(!hasRealGpu)("blends by per-layer opacity", async () => {
    const { installRenderer } = await import("./renderer.ts");
    const { createRaymarchScene } = await import("./volume/raymarchScene.ts");
    const { applyPose, createPerspectiveCamera } = await import("./camera/camera.ts");

    const renderer = await installRenderer({
      canvas: new OffscreenCanvas(SIZE, SIZE),
      width: SIZE,
      height: SIZE,
    });
    const camera = createPerspectiveCamera();
    applyPose(camera, CENTERED_POSE);

    // Two co-located blobs in distinct colormaps so a visible top layer measurably shifts the pixel.
    const bottom = createRaymarchScene({ field: blobField(), colormap: "inferno", density: 4 });
    const top = createRaymarchScene({ field: blobField(), colormap: "viridis", density: 4 });
    const center = SIZE >> 1;
    const stack = () =>
      renderer.readCompositePixels([
        { scene: bottom.scene, camera },
        { scene: top.scene, camera },
      ]);

    try {
      const bottomOnly = pixelAt(
        await renderer.readCompositePixels([{ scene: bottom.scene, camera }]),
        center,
        center,
      );
      expect(lum(bottomOnly)).toBeGreaterThan(50); // something actually rendered

      // Opacity 0 ⇒ the top layer contributes nothing ⇒ composite ≈ bottom alone.
      top.setOpacity(0);
      const invisibleTop = pixelAt(await stack(), center, center);
      // Opacity 1 ⇒ the top layer is fully present ⇒ it shifts the pixel markedly.
      top.setOpacity(1);
      const opaqueTop = pixelAt(await stack(), center, center);

      expect(dist(invisibleTop, bottomOnly)).toBeLessThanOrEqual(6); // invisible ≈ no-op
      expect(dist(opaqueTop, bottomOnly)).toBeGreaterThan(dist(invisibleTop, bottomOnly) + 20);
    } finally {
      bottom.dispose();
      top.dispose();
      renderer.dispose();
    }
  });

  it.skipIf(!hasRealGpu)("blends by draw order", async () => {
    const { installRenderer } = await import("./renderer.ts");
    const { createRaymarchScene } = await import("./volume/raymarchScene.ts");
    const { applyPose, createPerspectiveCamera } = await import("./camera/camera.ts");

    const renderer = await installRenderer({
      canvas: new OffscreenCanvas(SIZE, SIZE),
      width: SIZE,
      height: SIZE,
    });
    const camera = createPerspectiveCamera();
    applyPose(camera, CENTERED_POSE);

    const inferno = createRaymarchScene({ field: blobField(), colormap: "inferno", density: 4 });
    const viridis = createRaymarchScene({ field: blobField(), colormap: "viridis", density: 4 });
    const center = SIZE >> 1;

    try {
      const ab = pixelAt(
        await renderer.readCompositePixels([
          { scene: inferno.scene, camera },
          { scene: viridis.scene, camera },
        ]),
        center,
        center,
      );
      const ba = pixelAt(
        await renderer.readCompositePixels([
          { scene: viridis.scene, camera },
          { scene: inferno.scene, camera },
        ]),
        center,
        center,
      );
      // Front-to-back over-compositing: which layer is drawn last (on top) changes the overlap.
      expect(dist(ab, ba)).toBeGreaterThan(20);
    } finally {
      inferno.dispose();
      viridis.dispose();
      renderer.dispose();
    }
  });
});
