import type { ComputeBackend } from "@compute/backend.ts";
import type { RecipeKey } from "@compute/recipes.generated.ts";
import type { FieldDataset } from "@containers/field_dataset.ts";
import { expect } from "vitest";
import { assertAllclose } from "./helpers.ts";
import { TOL, type Tolerance } from "./tolerances.ts";

// Backend-agnostic equivalence harness: run a recipe through two ComputeBackends and assert they
// produce the same field — data within the kernel's f32 tolerance, metadata exactly. Parameterized on
// the backend pair, so a future WASM backend reuses it (ts-vs-wasm, wasm-vs-webgpu) without a rewrite.

export interface CrossBackendCase {
  readonly label: string;
  readonly recipe: RecipeKey;
  readonly tol: Tolerance;
}

// One case per kernel the TS and WGSL backends both bind (magnitude / divergence / curl ×3). Tolerance
// is the per-kernel webgpu_f32 cell — the documented f32 bound. Feeding f32 inputs to both backends,
// the TS path computes in f64 with f32 storage and the GPU in pure f32, so their gap sits well inside
// that cell (and never exceeds it).
export const CROSS_BACKEND_CASES: readonly CrossBackendCase[] = [
  { label: "|B| magnitude", recipe: "|B|", tol: TOL.magnitude.webgpu_f32 },
  { label: "div B", recipe: "div_B", tol: TOL.divergence.webgpu_f32 },
  { label: "curl B_1", recipe: "curl_B_1", tol: TOL.curl.webgpu_f32 },
  { label: "curl B_2", recipe: "curl_B_2", tol: TOL.curl.webgpu_f32 },
  { label: "curl B_3", recipe: "curl_B_3", tol: TOL.curl.webgpu_f32 },
];

// Assert `candidate` matches `reference` for one recipe: structural metadata exactly (the backends must
// package identical FieldArrays — shape/units/latex/reduction/quantityType), then the data within `tol`.
export async function assertBackendsAgree(
  reference: ComputeBackend,
  candidate: ComputeBackend,
  dataset: FieldDataset,
  testCase: CrossBackendCase,
): Promise<void> {
  const ref = await reference.compute(testCase.recipe, dataset);
  const cand = await candidate.compute(testCase.recipe, dataset);
  expect(cand.shape, `${testCase.label}: shape`).toEqual(ref.shape);
  expect(cand.units, `${testCase.label}: units`).toBe(ref.units);
  expect(cand.latex, `${testCase.label}: latex`).toBe(ref.latex);
  expect(cand.reduction, `${testCase.label}: reduction`).toEqual(ref.reduction);
  expect(cand.meta.quantityType, `${testCase.label}: quantityType`).toBe(ref.meta.quantityType);
  assertAllclose(cand.data, ref.data, testCase.tol);
}
