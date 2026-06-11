// Real-WebGPU regression test for the SWAPCHAIN present orientation. The deterministic readback
// path (readCompositePixels) composites into readTarget directly and never exercises the QuadMesh
// present at renderer.ts renderComposite — exactly where the upside-down ≥2-layer present bug
// lived (PlaneGeometry's GL-convention uvs vs WGSL's v=0=top render-target sampling). This test
// reads the real canvas after a present and asserts where each test-triangle color landed.
// Runs in the headed-Chrome `gpu` vitest project (`npm run test:gpu`) — local-only, not CI.

import { describe, expect, it } from "vitest";

const hasRealGpu =
  typeof navigator !== "undefined" && "gpu" in navigator && typeof OffscreenCanvas !== "undefined";

const SIZE = 64;

type Rgb = readonly [number, number, number];

describe("swapchain present orientation", () => {
  it.skipIf(!hasRealGpu)(
    "the ≥2-layer QuadMesh present keeps the image upright and unmirrored",
    async () => {
      const { installRenderer } = await import("./renderer.ts");
      const { createTestScene } = await import("./scene.ts");
      const { createOrthographicCamera } = await import("./camera.ts");
      const { Scene } = await import("three");

      const canvas = new OffscreenCanvas(SIZE, SIZE);
      const renderer = await installRenderer({ canvas, width: SIZE, height: SIZE });
      const testScene = createTestScene();
      const empty = new Scene(); // second item forces the composite-target + present path
      const camera = createOrthographicCamera();
      try {
        renderer.renderComposite([
          { scene: testScene.scene, camera },
          { scene: empty, camera },
        ]);
        // Let the frame actually present before sampling the canvas.
        await new Promise((resolve) => setTimeout(resolve));
        const bitmap = await createImageBitmap(await canvas.convertToBlob());
        const probe = new OffscreenCanvas(SIZE, SIZE);
        const ctx = probe.getContext("2d");
        if (ctx === null) throw new Error("no 2d context for the probe canvas");
        ctx.drawImage(bitmap, 0, 0);
        const image = ctx.getImageData(0, 0, SIZE, SIZE);
        const at = (col: number, row: number): Rgb => {
          const i = (row * SIZE + col) * 4;
          return [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
        };

        // Test triangle: red vertex at (0, +0.8), green at (−0.8, −0.6), blue at (+0.8, −0.6).
        // Upright + unmirrored ⇒ red top-center, green lower-left, blue lower-right.
        const top = at(SIZE >> 1, Math.round(SIZE * 0.25));
        const lowerLeft = at(Math.round(SIZE * 0.2), Math.round(SIZE * 0.78));
        const lowerRight = at(Math.round(SIZE * 0.8), Math.round(SIZE * 0.78));
        expect(top[0]).toBeGreaterThan(top[1] + 30); // red over green
        expect(top[0]).toBeGreaterThan(top[2] + 30); // red over blue — catches a vertical flip
        expect(lowerLeft[1]).toBeGreaterThan(lowerLeft[0] + 30); // green dominant
        expect(lowerLeft[1]).toBeGreaterThan(lowerLeft[2] + 30);
        expect(lowerRight[2]).toBeGreaterThan(lowerRight[0] + 30); // blue dominant — catches a mirror
        expect(lowerRight[2]).toBeGreaterThan(lowerRight[1] + 30);
      } finally {
        testScene.dispose();
        renderer.dispose();
      }
    },
  );
});
