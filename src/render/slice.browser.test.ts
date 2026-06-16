// Real-WebGPU smoke: a slice scene built from a single-axis ramp field must paint that
// ramp across the screen in the themed colormap. Asserts color-space-agnostic properties
// (monotonic luminance along the ramp axis + inferno's dark→yellow endpoints) so the test
// holds whether the runner reads back linear or sRGB-encoded bytes. The single-axis ramp
// also fails loudly if the C-order → texture-axis mapping is transposed. Skipped wherever
// WebGPU is absent (Node PR gate skips green); runner imports `three/webgpu` dynamically.

import type { FieldArray } from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";
import { describe, expect, it } from "vitest";

const hasRealGpu =
  typeof navigator !== "undefined" && "gpu" in navigator && typeof OffscreenCanvas !== "undefined";

const SIZE = 32;

// |B| ramping 0→1 along the last (fastest, C-order) axis, flat across the other two.
function rampField(): FieldArray {
  const [nx, ny, nz] = [4, 4, 8];
  const data = new Float32Array(nx * ny * nz);
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        data[iz + nz * (iy + ny * ix)] = iz / (nz - 1);
      }
    }
  }
  const meta = fieldInfo("|B|");
  return {
    data,
    shape: [nx, ny, nz],
    meta,
    units: meta.siUnit,
    latex: meta.latex,
    reduction: null,
  };
}

async function renderSlicePixels(): Promise<Uint8Array> {
  const { installRenderer } = await import("./runtime/renderer.ts");
  const { createSliceScene } = await import("./volume/sliceScene.ts");
  const { createOrthographicCamera } = await import("./camera/camera.ts");
  const renderer = await installRenderer({
    canvas: new OffscreenCanvas(SIZE, SIZE),
    width: SIZE,
    height: SIZE,
  });
  // axis "x" holds field axis 0; the ramp (field axis 2) maps to texture-x → screen-x.
  const slice = createSliceScene({
    field: rampField(),
    colormap: "inferno",
    axis: "x",
    position: 0.5,
  });
  const camera = createOrthographicCamera();
  try {
    return await renderer.readPixels(slice.scene, camera);
  } finally {
    slice.dispose();
    renderer.dispose();
  }
}

describe("slice scene render", () => {
  it.skipIf(!hasRealGpu)("paints a horizontal inferno ramp from the field", async () => {
    const px = await renderSlicePixels();
    const row = SIZE >> 1;
    const at = (col: number): readonly [number, number, number] => {
      const i = (row * SIZE + col) * 4;
      return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
    };
    const lum = ([r, g, b]: readonly [number, number, number]): number =>
      0.2126 * r + 0.7152 * g + 0.0722 * b;

    const left = at(0);
    const center = at(SIZE >> 1);
    const right = at(SIZE - 1);

    // Monotonic along screen-x ⇒ orientation + normalization correct (a transposed upload
    // would make the row roughly constant and fail here).
    expect(lum(left)).toBeLessThan(lum(center));
    expect(lum(center)).toBeLessThan(lum(right));

    // inferno endpoints: near-black at t=0, bright yellow at t=1 (blue < red, not greyscale).
    expect(lum(left)).toBeLessThan(40);
    expect(lum(right)).toBeGreaterThan(180);
    expect(right[2]).toBeLessThan(right[0]);
  });
});
