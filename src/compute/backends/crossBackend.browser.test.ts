// Cross-backend equivalence: the TS reference backend and the WebGPU backend must produce the same
// field — same data within f32 tolerance, same packaged metadata — for every op they both bind
// (magnitude / divergence / curl). This drives the full ComputeBackend path on both sides (recipe
// resolution, input gathering, FieldArray packaging), the symmetric twin of parity.browser, which
// compares the WGSL kernel to the coordinates/derived functions directly. Both backends bind the same
// op set now (M3.3 added TS curl/divergence), so the harness covers it kernel-for-kernel.
// Runs only under the gpu project (WEBPIC_GPU=1, headed Chrome); skipped green where WebGPU is absent.

import { tsBackend } from "@compute/backends/ts/index.ts";
import { webgpuBackend } from "@compute/backends/webgpu/index.ts";
import { hasDevice, installGpu } from "@gpu/device.ts";
import { afterAll, beforeAll, describe, it } from "vitest";
import { smoothVectorField } from "../../../tests/analyticField.ts";
import { assertBackendsAgree, CROSS_BACKEND_CASES } from "../../../tests/crossBackend.ts";

const hasRealGpu = typeof navigator !== "undefined" && "gpu" in navigator;

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

describe("ts vs webgpu backend equivalence", () => {
  // f32 inputs to both backends → the only gap is the f32-vs-f64 arithmetic each kernel's webgpu_f32
  // cell already bounds (no input-rounding skew). Inputs are never mutated, so one field serves all cases.
  const { dataset } = smoothVectorField();

  for (const testCase of CROSS_BACKEND_CASES) {
    it.skipIf(!hasRealGpu)(`agrees on ${testCase.label}`, async () => {
      await assertBackendsAgree(tsBackend, webgpuBackend, dataset, testCase);
    });
  }
});
