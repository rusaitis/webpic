// Real-WebGPU parity for the field-operator kernels: the GPU magnitude / curl / divergence must
// match the `coordinates/` + `derived/` TS twins. Inputs are built as Float32Array and fed to BOTH
// sides, so the only gap is f32-vs-f64 *arithmetic* (not rounded-input skew) — bounded by TOL.webgpu_f32.
// A smooth analytic field (well-conditioned differences), a distinct-dims shape (every axis hits all
// three stencil branches; a transposed stride fails loudly), and one 256³ run that crosses the
// 65535-workgroup cap to exercise the kernel's grid-stride wraparound. Runs only under the gpu project
// (`WEBPIC_GPU=1`, headed Chrome); skipped green where WebGPU is absent.

import type { FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { curl, divergence } from "@coordinates/operators.ts";
import { vectorMagnitude } from "@derived/magnitude.ts";
import { hasDevice, installGpu } from "@gpu/device.ts";
import type { Vec3 } from "@schema/types.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fieldArray, makeDataset } from "../../../../tests/fixtures.ts";
import { assertAllclose } from "../../../../tests/helpers.ts";
import { TOL } from "../../../../tests/tolerances.ts";
import { webgpuBackend } from "./index.ts";

const hasRealGpu = typeof navigator !== "undefined" && "gpu" in navigator;

function gridOf(shape: readonly number[], spacing: Vec3): GridInfo {
  return {
    dimensions: [...shape],
    spacing: [...spacing],
    origin: [0, 0, 0],
    geometry: "cartesian",
    axisLabels: ["x", "y", "z"],
    dt: null,
    boundary: null,
    survivingAxes: null,
    stagger: null,
  };
}

function vectorDataset(
  shape: readonly number[],
  spacing: Vec3,
  f1: Float32Array,
  f2: Float32Array,
  f3: Float32Array,
): FieldDataset {
  return makeDataset(
    {
      B_1: fieldArray("B_1", f1, shape),
      B_2: fieldArray("B_2", f2, shape),
      B_3: fieldArray("B_3", f3, shape),
    },
    { grid: gridOf(shape, spacing) },
  );
}

type ScalarFn = (x: number, y: number, z: number) => number;

// Sample fn over the row-major grid at physical coordinates index*spacing (origin 0).
function sampleField(shape: readonly number[], spacing: Vec3, fn: ScalarFn): Float32Array {
  const [nx, ny, nz] = [shape[0] ?? 1, shape[1] ?? 1, shape[2] ?? 1];
  const out = new Float32Array(nx * ny * nz);
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        out[(ix * ny + iy) * nz + iz] = fn(ix * spacing[0], iy * spacing[1], iz * spacing[2]);
      }
    }
  }
  return out;
}

// Smooth, O(1)-amplitude components with non-trivial curl and divergence everywhere.
const F1: ScalarFn = (x, y, z) => Math.sin(0.7 * x) * Math.cos(0.5 * y) + 0.2 * z;
const F2: ScalarFn = (x, y, z) => Math.cos(0.4 * x) * Math.sin(0.6 * y) * Math.cos(0.3 * z);
const F3: ScalarFn = (x, y, z) => Math.sin(0.3 * x + 0.2 * y) + 0.5 * Math.cos(0.4 * z);

const SHAPE: readonly number[] = [5, 4, 3]; // distinct dims + anisotropic spacing
const SPACING: Vec3 = [0.5, 1, 2];

function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] ?? 0));
  return m;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}

let installed = false;
let dispose: (() => void) | undefined;

beforeAll(async () => {
  if (!hasRealGpu || hasDevice()) return; // a sibling suite may already hold the singleton
  const handle = await installGpu();
  dispose = handle.dispose;
  installed = true;
});

afterAll(() => {
  if (installed) dispose?.();
});

describe("webgpu field-op parity vs the coordinates/derived twins", () => {
  it.skipIf(!hasRealGpu)("magnitude matches vectorMagnitude", async () => {
    const f1 = sampleField(SHAPE, SPACING, F1);
    const f2 = sampleField(SHAPE, SPACING, F2);
    const f3 = sampleField(SHAPE, SPACING, F3);
    const gpu = await webgpuBackend.compute("|B|", vectorDataset(SHAPE, SPACING, f1, f2, f3));
    const twin = vectorMagnitude(f1, f2, f3);
    expect(maxAbs(twin)).toBeGreaterThan(0.5); // non-vacuous
    assertAllclose(gpu.data, twin, TOL.webgpu_f32);
  });

  it.skipIf(!hasRealGpu)("divergence matches the central/one-sided stencil", async () => {
    const f1 = sampleField(SHAPE, SPACING, F1);
    const f2 = sampleField(SHAPE, SPACING, F2);
    const f3 = sampleField(SHAPE, SPACING, F3);
    const gpu = await webgpuBackend.compute("div_B", vectorDataset(SHAPE, SPACING, f1, f2, f3));
    const twin = divergence(f1, f2, f3, SHAPE, SPACING);
    expect(maxAbs(twin)).toBeGreaterThan(0.1);
    assertAllclose(gpu.data, twin, TOL.webgpu_f32);
  });

  it.skipIf(!hasRealGpu)("each curl component matches the twin", async () => {
    const f1 = sampleField(SHAPE, SPACING, F1);
    const f2 = sampleField(SHAPE, SPACING, F2);
    const f3 = sampleField(SHAPE, SPACING, F3);
    const ds = vectorDataset(SHAPE, SPACING, f1, f2, f3);
    const [t1, t2, t3] = curl(f1, f2, f3, SHAPE, SPACING);
    const g1 = await webgpuBackend.compute("curl_B_1", ds);
    const g2 = await webgpuBackend.compute("curl_B_2", ds);
    const g3 = await webgpuBackend.compute("curl_B_3", ds);
    expect(maxAbs(t1) + maxAbs(t2) + maxAbs(t3)).toBeGreaterThan(0.1);
    assertAllclose(g1.data, t1, TOL.webgpu_f32);
    assertAllclose(g2.data, t2, TOL.webgpu_f32);
    assertAllclose(g3.data, t3, TOL.webgpu_f32);
  });

  it.skipIf(!hasRealGpu)("rejects a non-cartesian grid like the TS reference", async () => {
    const f = sampleField(SHAPE, SPACING, F1);
    const ds = makeDataset(
      {
        B_1: fieldArray("B_1", f, SHAPE),
        B_2: fieldArray("B_2", f, SHAPE),
        B_3: fieldArray("B_3", f, SHAPE),
      },
      { grid: { ...gridOf(SHAPE, SPACING), geometry: "spherical" } },
    );
    await expect(webgpuBackend.compute("div_B", ds)).rejects.toThrow(/geometry not implemented/);
  });

  // 256³ = 16,777,216 > 65535*256 = 16,776,960, so the last 256 elements only get computed on the
  // grid-stride loop's second iteration. Cheap integer fills + a manual max-diff keep the 16.7M-element
  // comparison fast (no per-element expect).
  it.skipIf(!hasRealGpu)("256³ magnitude exercises the grid-stride wraparound", async () => {
    const n = 256 * 256 * 256;
    const shape: readonly number[] = [256, 256, 256];
    const f1 = new Float32Array(n);
    const f2 = new Float32Array(n);
    const f3 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      f1[i] = (i % 7) + 1;
      f2[i] = (i % 5) + 1;
      f3[i] = i % 3;
    }
    const gpu = await webgpuBackend.compute("|B|", vectorDataset(shape, [1, 1, 1], f1, f2, f3));
    const twin = vectorMagnitude(f1, f2, f3);
    expect(gpu.data.length).toBe(n);
    expect(maxAbsDiff(gpu.data, twin)).toBeLessThanOrEqual(1e-3);
    // Spot-check the wraparound tail explicitly (indices computed only on the 2nd loop pass).
    for (const i of [n - 1, n - 128, n - 256]) {
      expect(gpu.data[i] ?? 0).toBeCloseTo(twin[i] ?? 0, 3);
    }
  });
});
