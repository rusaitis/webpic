// Cross-backend equivalence: the TS reference backend and the WebGPU backend must produce the same
// field — same data within f32 tolerance, same packaged metadata — for every op they both bind
// (magnitude / divergence / curl). This drives the full ComputeBackend path on both sides (recipe
// resolution, input gathering, FieldArray packaging), the symmetric twin of parity.browser, which
// compares the WGSL kernel to the coordinates/derived functions directly. Both backends bind the same
// op set now (TS curl/divergence included), so the harness covers it kernel-for-kernel. The second
// suite pins the WebGPU backend against the checked-in pypic goldens (the f64 authority) at the same
// webgpu_f32 bound, closing the TS≡WebGPU≡pypic triangle the node tests/goldens.test.ts opens at f64.
// Runs only under the gpu project (WEBPIC_GPU=1, headed Chrome); skipped green where WebGPU is absent.

import { tsBackend } from "@compute/backends/ts/index.ts";
import { webgpuBackend } from "@compute/backends/webgpu/index.ts";
import { hasDevice, installGpu } from "@gpu/device.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { smoothVectorField } from "../../../tests/analyticField.ts";
import { sampleScalar } from "../../../tests/analyticFieldCore.ts";
import { assertBackendsAgree, CROSS_BACKEND_CASES } from "../../../tests/crossBackend.ts";
import goldenJson from "../../../tests/fixtures/v1/smooth-field.json";
import { makeDataset, makeField, makeGrid } from "../../../tests/fixtures.ts";
import { assertAllclose } from "../../../tests/helpers.ts";
import { SYNTHETIC_FIELDS, spacingFor } from "../../../tests/syntheticFieldsCore.ts";

interface GoldenFixture {
  readonly grid: { readonly shape: readonly number[]; readonly spacing: [number, number, number] };
  readonly inputs: { readonly B_1: number[]; readonly B_2: number[]; readonly B_3: number[] };
  readonly goldens: Record<string, number[]>;
}
// Vite types a JSON import structurally (literal keys); assert the generated fixture's contract.
const golden = goldenJson as unknown as GoldenFixture;

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

describe("ts vs webgpu backend equivalence", () => {
  // f32 inputs to both backends → the only gap is the f32-vs-f64 arithmetic each kernel's webgpu_f32
  // cell already bounds (no input-rounding skew). Inputs are never mutated, so one field serves all cases.
  const { dataset } = smoothVectorField();

  for (const testCase of CROSS_BACKEND_CASES) {
    it(`agrees on ${testCase.label}`, async () => {
      await assertBackendsAgree(tsBackend, webgpuBackend, dataset, testCase);
    });
  }
});

describe("webgpu backend vs pypic goldens", () => {
  // f32 inputs (the GPU storage precision) reconstructed from the fixture — bit-identical to the f32
  // the equivalence suite feeds, since both round the same f64 sample. The gap to the f64 golden is
  // the f32 arithmetic the recipe's webgpu_f32 cell already bounds, plus a ~1e-7 input-rounding term
  // this well-conditioned field keeps well inside that cell. CROSS_BACKEND_CASES carries both the
  // recipe and its webgpu_f32 tolerance, so the case list and the bound stay single-sourced.
  const toF32 = (values: number[]): Float32Array => Float32Array.from(values);
  const dataset = makeDataset(
    {
      B_1: makeField("B_1", toF32(golden.inputs.B_1), golden.grid.shape),
      B_2: makeField("B_2", toF32(golden.inputs.B_2), golden.grid.shape),
      B_3: makeField("B_3", toF32(golden.inputs.B_3), golden.grid.shape),
    },
    { grid: makeGrid(golden.grid.shape, golden.grid.spacing) },
  );

  for (const testCase of CROSS_BACKEND_CASES) {
    it(`matches pypic on ${testCase.label}`, async () => {
      const expected = golden.goldens[testCase.recipe];
      expect(expected, `fixture missing golden for ${testCase.recipe}`).toBeDefined();
      if (expected === undefined) return;
      const result = await webgpuBackend.compute(testCase.recipe, dataset);
      assertAllclose(result.data, expected, testCase.tol);
    });
  }
});

describe("ts vs webgpu — synthetic MHD fields", () => {
  // Orszag–Tang / Harris / GEM: divergence-free fields with a tanh kink and a magnetic island — a harder
  // cross-backend stress than the smooth field (zero-crossings, near-cancelling divergence). f32 to both
  // backends, so the only gap is the f32-vs-f64 arithmetic each kernel's webgpu_f32 cell bounds. The
  // closed-form goldens themselves are validated TS-side in tests/synthetic.test.ts (node); here we only
  // assert the two backends agree on the same turbulent inputs.
  for (const field of SYNTHETIC_FIELDS) {
    const spacing = spacingFor(field, field.shape);
    const [b1, b2, b3] = field.components;
    const dataset = makeDataset(
      {
        B_1: makeField("B_1", sampleScalar(field.shape, spacing, b1, Float32Array), field.shape),
        B_2: makeField("B_2", sampleScalar(field.shape, spacing, b2, Float32Array), field.shape),
        B_3: makeField("B_3", sampleScalar(field.shape, spacing, b3, Float32Array), field.shape),
      },
      { grid: makeGrid(field.shape, spacing) },
    );
    for (const testCase of CROSS_BACKEND_CASES) {
      it(`${field.name}: agrees on ${testCase.label}`, async () => {
        await assertBackendsAgree(tsBackend, webgpuBackend, dataset, testCase);
      });
    }
  }
});
