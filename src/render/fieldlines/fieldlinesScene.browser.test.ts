// Real-WebGPU smoke for the batched fat-line scene: build a `LineSegments2` from a few world-space
// polylines, render one composite item, and assert the lines actually drew (bright pixels appear over
// the dark clear). One smoke, no pixel-exact asserts (CLAUDE.md: no flaky visual tests). Runs in the
// headed-Chrome `gpu` vitest project (`npm run test:gpu`) — local-only, not CI.

import { describe, expect, it } from "vitest";

const hasRealGpu =
  typeof navigator !== "undefined" && "gpu" in navigator && typeof OffscreenCanvas !== "undefined";

const SIZE = 96;

describe("fieldlines scene", () => {
  it.skipIf(!hasRealGpu)("renders batched polylines to the canvas", async () => {
    const { installRenderer } = await import("../runtime/renderer.ts");
    const { createOrthographicCamera } = await import("../camera/camera.ts");
    const { createFieldlinesScene } = await import("./fieldlinesScene.ts");

    // Three horizontal lines (2 vertices each) across the head-on ortho view, in the z=0 plane.
    const positions = new Float32Array([
      -0.4, -0.3, 0, 0.4, -0.3, 0, -0.4, 0, 0, 0.4, 0, 0, -0.4, 0.3, 0, 0.4, 0.3, 0,
    ]);
    const counts = new Uint32Array([2, 2, 2]);

    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const renderer = await installRenderer({ canvas, width: SIZE, height: SIZE });
    const lines = createFieldlinesScene({
      positions,
      counts,
      color: [1, 1, 1, 1], // white over the dark clear
      linewidth: 3,
    });
    const camera = createOrthographicCamera();
    try {
      renderer.renderComposite([{ scene: lines.scene, camera }]);
      await new Promise((resolve) => setTimeout(resolve)); // let the frame present
      const bitmap = await createImageBitmap(await canvas.convertToBlob());
      const probe = new OffscreenCanvas(SIZE, SIZE);
      const ctx = probe.getContext("2d");
      if (ctx === null) throw new Error("no 2d context for the probe canvas");
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, SIZE, SIZE).data;

      // The corner is background; count pixels markedly brighter than it (the white lines).
      const bg = (image[0] ?? 0) + (image[1] ?? 0) + (image[2] ?? 0);
      let bright = 0;
      for (let i = 0; i < image.length; i += 4) {
        const lum = (image[i] ?? 0) + (image[i + 1] ?? 0) + (image[i + 2] ?? 0);
        if (lum > bg + 150) bright++;
      }
      // ~3 lines × 3 px wide across a 96-wide canvas ⇒ hundreds of lit pixels; a tiny floor catches
      // "nothing drew" without pinning the exact rasterization.
      expect(bright).toBeGreaterThan(50);
    } finally {
      lines.dispose();
      renderer.dispose();
    }
  });
});
