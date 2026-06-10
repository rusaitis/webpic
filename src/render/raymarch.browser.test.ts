// Real-WebGPU smoke for the volume raymarcher. Asserts color-space-agnostic luminance relations
// (so it holds whether the runner reads back linear or sRGB bytes) and exercises the analytic
// ray-box + early-α compositing end-to-end. The orientation case uses a single-axis ramp + a
// straight-on camera so a transposed/flipped texture upload fails loudly (a symmetric blob can't
// catch that). Skipped wherever WebGPU is absent (Node PR gate skips green); the runner imports
// `three`/`three/webgpu` dynamically so Node never loads them.

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

// |B| ramping 0→1 along the fastest (C-order) axis, flat across the other two. That axis is
// texture-x → object-x, so a straight-on camera renders it brightening to the right.
function rampAlongObjectXField(): ScalarField {
  const [nz, ny, nx] = [8, 8, 8]; // shape = [depth, height, width]; width (x) is fastest
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        data[x + nx * (y + ny * z)] = x / (nx - 1);
      }
    }
  }
  return { data, shape: [nz, ny, nx] };
}

// A unit-valued ball at the volume center, exactly 0 outside `radius` — most of the volume is empty,
// so a small brick size skips it while one brick (≥ the volume) marches every lattice step. The
// zero exterior makes the two output-identical (a skipped brick and a marched-but-zero brick both
// contribute nothing), giving an exact image-parity reference for empty-space skipping.
function centralBallField(n: number, radius: number): ScalarField {
  const data = new Float32Array(n * n * n);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5) / n - 0.5;
        const dy = (y + 0.5) / n - 0.5;
        const dz = (z + 0.5) / n - 0.5;
        data[x + n * (y + n * z)] = Math.sqrt(dx * dx + dy * dy + dz * dz) < radius ? 1 : 0;
      }
    }
  }
  return { data, shape: [n, n, n] };
}

// Render a field, optionally from a straight-on camera (object-x → screen-x) instead of the
// scene's default oblique view, so the orientation case can assert a screen-space direction.
// `march` opts in to empty-space skipping (default off — the fixed march) and tunes its brick size.
// `orthographic` renders with the matched-frustum ortho volume camera + parallel-ray generation.
async function renderVolume(
  field: ScalarField,
  straightOn = false,
  march: { readonly skipEmptySpace?: boolean; readonly brickSize?: number } = {},
  orthographic = false,
): Promise<Uint8Array> {
  const { installRenderer } = await import("./renderer.ts");
  const { createRaymarchScene } = await import("./raymarchScene.ts");
  const {
    applyPose,
    applyPoseOrtho,
    createPerspectiveCamera,
    createVolumeOrthographicCamera,
    DEFAULT_POSE,
  } = await import("./camera.ts");
  const renderer = await installRenderer({
    canvas: new OffscreenCanvas(SIZE, SIZE),
    width: SIZE,
    height: SIZE,
  });
  const volume = createRaymarchScene({ field, colormap: "inferno", density: 4, ...march });
  volume.setProjection(orthographic);
  // The worker owns the camera now; build the same default oblique view here, or a straight-on
  // view (looking down −z from +z) for the orientation case.
  const pose = straightOn
    ? ({ target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 2 } as const)
    : DEFAULT_POSE;
  let camera: import("three").PerspectiveCamera | import("three").OrthographicCamera;
  if (orthographic) {
    camera = createVolumeOrthographicCamera();
    applyPoseOrtho(camera, pose);
  } else {
    camera = createPerspectiveCamera();
    applyPose(camera, pose);
  }
  try {
    return await renderer.readPixels(volume.scene, camera);
  } finally {
    volume.dispose();
    renderer.dispose();
  }
}

const lum = ([r, g, b]: readonly [number, number, number]): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

function pixelAt(px: Uint8Array, col: number, row: number): readonly [number, number, number] {
  const i = (row * SIZE + col) * 4;
  return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
}

describe("raymarch scene render", () => {
  it.skipIf(!hasRealGpu)("accumulates a bright core where the box projects", async () => {
    const px = await renderVolume(blobField());
    const center = pixelAt(px, SIZE >> 1, SIZE >> 1);
    const corner = pixelAt(px, 0, 0);

    // The blob accumulates inferno color at the center; the corner stays at the dark background.
    expect(lum(center)).toBeGreaterThan(lum(corner) + 20);
    // Non-background core (background 0x101820 ⇒ luminance ≈ 23).
    expect(lum(center)).toBeGreaterThan(50);
    // inferno warm core: red dominates blue (a greyscale path would fail this).
    expect(center[0]).toBeGreaterThan(center[2]);
  });

  it.skipIf(!hasRealGpu)("maps the fastest field axis to object-x", async () => {
    const px = await renderVolume(rampAlongObjectXField(), true);
    const row = SIZE >> 1;
    // Columns inside the projected cube (it spans ~the central 60% of the frame).
    const left = pixelAt(px, Math.round(SIZE * 0.32), row);
    const right = pixelAt(px, Math.round(SIZE * 0.68), row);

    // Straight-on, object-x → screen-x: the ramp brightens to the right. A transposed upload
    // (ramp along the view axis) integrates to a roughly flat row and fails here.
    expect(lum(right)).toBeGreaterThan(lum(left) + 15);
    expect(right[0]).toBeGreaterThan(right[2]); // warm (inferno), not greyscale
  });

  it.skipIf(!hasRealGpu)(
    "orthographic projection renders the same bright core at matched framing",
    async () => {
      const persp = await renderVolume(blobField());
      const ortho = await renderVolume(blobField(), false, {}, true);
      const center = pixelAt(ortho, SIZE >> 1, SIZE >> 1);
      const corner = pixelAt(ortho, 0, 0);
      // Parallel rays still accumulate the centered blob; the corner stays background.
      expect(lum(center)).toBeGreaterThan(lum(corner) + 20);
      expect(lum(center)).toBeGreaterThan(50);
      // The matched frustum shows the same extent at the target plane: the center pixel marches
      // the same chord through the blob either way, so the core brightness is close.
      const perspCenter = pixelAt(persp, SIZE >> 1, SIZE >> 1);
      expect(Math.abs(lum(center) - lum(perspCenter))).toBeLessThan(40);
    },
  );

  it.skipIf(!hasRealGpu)(
    "empty-space skipping matches the fixed march pixel-for-pixel",
    async () => {
      const field = centralBallField(32, 0.18); // most of the 32³ volume is empty around the ball
      const skipped = await renderVolume(field, false, { skipEmptySpace: true, brickSize: 4 });
      const fixed = await renderVolume(field, false, {}); // default fixed march — the reference

      expect(skipped.length).toBe(fixed.length);
      // Snapping keeps occupied samples on the same lattice and the exterior is exactly 0, so the two
      // accumulate the identical non-zero sequence — equal within byte rounding, not merely close.
      let maxDiff = 0;
      let nonBackground = 0;
      for (let i = 0; i < fixed.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          maxDiff = Math.max(maxDiff, Math.abs((skipped[i + c] ?? 0) - (fixed[i + c] ?? 0)));
        }
        if ((fixed[i] ?? 0) > 40) nonBackground++; // the ball must actually render, else parity is vacuous
      }
      expect(nonBackground).toBeGreaterThan(20);
      expect(maxDiff).toBeLessThanOrEqual(2);
    },
  );
});
