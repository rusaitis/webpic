// Real-WebGPU parity for the field-operator kernels: the GPU magnitude / curl / divergence must
// match the `coordinates/` + `derived/` TS twins. Inputs are built as Float32Array and fed to BOTH
// sides, so the only gap is f32-vs-f64 *arithmetic* (not rounded-input skew) — bounded by each
// kernel's TOL.*.webgpu_f32 row.
// A smooth analytic field (well-conditioned differences, shared via tests/analyticField), a
// distinct-dims shape (every axis hits all three stencil branches; a transposed stride fails loudly),
// and one 256³ run that crosses the 65535-workgroup cap to exercise the kernel's grid-stride
// wraparound. Runs only under the gpu project (`WEBPIC_GPU=1`, headed Chrome); skipped green where
// WebGPU is absent. The symmetric ts-vs-webgpu comparison lives in crossBackend.browser.test.ts.

import { curl, divergence } from "@coordinates/operators.ts";
import { vectorMagnitude } from "@derived/magnitude.ts";
import { hasDevice, installGpu } from "@gpu/device.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  maxAbs,
  SMOOTH_SHAPE,
  SMOOTH_SPACING,
  smoothVectorField,
} from "../../../../tests/analyticField.ts";
import { makeDataset, makeField, makeGrid } from "../../../../tests/fixtures.ts";
import { assertAllclose } from "../../../../tests/helpers.ts";
import { TOL } from "../../../../tests/tolerances.ts";
import { webgpuBackend } from "./index.ts";

let installed = false;
let dispose: (() => void) | undefined;

beforeAll(async () => {
  if (hasDevice()) return; // a sibling suite may already hold the singleton
  const handle = await installGpu();
  dispose = handle.dispose;
  installed = true;
});

afterAll(() => {
  if (installed) dispose?.();
});

describe("webgpu field-op parity vs the coordinates/derived twins", () => {
  // The shared smooth field (f32), reused across the magnitude/div/curl cases; compute never mutates
  // its inputs, so one instance serves all three.
  const { shape, spacing, f1, f2, f3, dataset } = smoothVectorField();

  it("magnitude matches vectorMagnitude", async () => {
    const gpu = await webgpuBackend.compute("|B|", dataset);
    const twin = vectorMagnitude(f1, f2, f3);
    expect(maxAbs(twin)).toBeGreaterThan(0.5); // non-vacuous
    assertAllclose(gpu.data, twin, TOL.magnitude.webgpu_f32);
  });

  it("divergence matches the central/one-sided stencil", async () => {
    const gpu = await webgpuBackend.compute("div_B", dataset);
    const twin = divergence(f1, f2, f3, shape, spacing);
    expect(maxAbs(twin)).toBeGreaterThan(0.1);
    assertAllclose(gpu.data, twin, TOL.divergence.webgpu_f32);
  });

  it("each curl component matches the twin", async () => {
    const [t1, t2, t3] = curl(f1, f2, f3, shape, spacing);
    const g1 = await webgpuBackend.compute("curl_B_1", dataset);
    const g2 = await webgpuBackend.compute("curl_B_2", dataset);
    const g3 = await webgpuBackend.compute("curl_B_3", dataset);
    expect(maxAbs(t1) + maxAbs(t2) + maxAbs(t3)).toBeGreaterThan(0.1);
    assertAllclose(g1.data, t1, TOL.curl.webgpu_f32);
    assertAllclose(g2.data, t2, TOL.curl.webgpu_f32);
    assertAllclose(g3.data, t3, TOL.curl.webgpu_f32);
  });

  it("rejects a non-cartesian grid like the TS reference", async () => {
    const ds = makeDataset(
      {
        B_1: makeField("B_1", f1, shape),
        B_2: makeField("B_2", f2, shape),
        B_3: makeField("B_3", f3, shape),
      },
      { grid: { ...makeGrid(SMOOTH_SHAPE, SMOOTH_SPACING), geometry: "spherical" } },
    );
    await expect(webgpuBackend.compute("div_B", ds)).rejects.toThrow(/geometry not implemented/);
  });

  // 256³ = 16,777,216 > 65535*256 = 16,776,960, so the last 256 elements only get computed on the
  // grid-stride loop's second iteration. Integer fills keep the 16.7M-element comparison cheap; the
  // tail indices (computed only on the 2nd loop pass) are inside the same allclose scan.
  it("256³ magnitude exercises the grid-stride wraparound", async () => {
    const n = 256 * 256 * 256;
    const bigShape: readonly number[] = [256, 256, 256];
    const b1 = new Float32Array(n);
    const b2 = new Float32Array(n);
    const b3 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      b1[i] = (i % 7) + 1;
      b2[i] = (i % 5) + 1;
      b3[i] = i % 3;
    }
    const ds = makeDataset(
      {
        B_1: makeField("B_1", b1, bigShape),
        B_2: makeField("B_2", b2, bigShape),
        B_3: makeField("B_3", b3, bigShape),
      },
      { grid: makeGrid(bigShape, [1, 1, 1]) },
    );
    const gpu = await webgpuBackend.compute("|B|", ds);
    const twin = vectorMagnitude(b1, b2, b3);
    expect(gpu.data.length).toBe(n);
    assertAllclose(gpu.data, twin, TOL.magnitude.webgpu_f32);
  });
});
