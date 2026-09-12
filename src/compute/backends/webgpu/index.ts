// STAGED: activates when the data worker can hand GPU compute to main (a worker holds no device).
import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { require3dVector, requireCartesian, requirePositiveSpacing } from "@coordinates/guards.ts";
import { runFieldKernel } from "@gpu/computeKernel.ts";
import { getDevice, hasDevice } from "@gpu/device.ts";
import {
  CURL_ENTRY,
  DIVERGENCE_ENTRY,
  FIELD_OPS_WGSL,
  MAGNITUDE_ENTRY,
} from "@shaders/kernels/fieldOps.wgsl.ts";
import type { ComputeBackend } from "../../backend.ts";
import { gatherRecipeInputs, type RecipeMeta, recipeFieldArray } from "../../recipe.ts";
import { RECIPES, type RecipeKey } from "../../recipes.generated.ts";
import { buildKernelParams, toFloat32 } from "./params.ts";

// One WGSL kernel per op, bound to the codegen'd recipe `func` names (mirrors `TS_FIELD_OPS` in the
// TS backend). `div_e` shares the divergence kernel — it's field-agnostic, so binding it is free
// coverage. `needsGrid` drives the cartesian/spacing validation below; the magnitude family ignores
// the grid entirely.
interface KernelDesc {
  readonly entryPoint: string;
  readonly needsGrid: boolean;
}
const MAGNITUDE_KERNEL: KernelDesc = { entryPoint: MAGNITUDE_ENTRY, needsGrid: false };
const CURL_KERNEL: KernelDesc = { entryPoint: CURL_ENTRY, needsGrid: true };
const DIVERGENCE_KERNEL: KernelDesc = { entryPoint: DIVERGENCE_ENTRY, needsGrid: true };

const WEBGPU_FIELD_OPS: Record<string, KernelDesc> = {
  magnetic_field_magnitude: MAGNITUDE_KERNEL,
  electric_field_magnitude: MAGNITUDE_KERNEL,
  current_density_magnitude: MAGNITUDE_KERNEL,
  velocity_magnitude: MAGNITUDE_KERNEL,
  curl: CURL_KERNEL,
  div_b: DIVERGENCE_KERNEL,
  div_e: DIVERGENCE_KERNEL,
};

// Can a WebGPU kernel evaluate this recipe (ignoring device availability)? Pure, so the gating logic
// unit-tests in Node. Unlike the TS backend we do NOT reject `component`/`needsGrid`: curl carries
// `component:0/1/2` and `needsGrid:true` — both are exactly what the kernel handles. Gamma/c/species
// recipes are out of scope (no kernel bound yet).
export function isWebgpuOp(recipe: RecipeMeta): boolean {
  return (
    !recipe.needsGamma &&
    !recipe.needsC &&
    recipe.speciesArgs === null &&
    Object.hasOwn(WEBGPU_FIELD_OPS, recipe.func)
  );
}

// The grid preconditions are the TS reference's own guards, called with this backend's label, so the
// two paths refuse the same inputs. The sample count is checked here rather than in the kernel: a
// WGSL dispatch has no way to throw, and np.gradient needs the neighbour plane on every axis.
function validateGridOp(inputs: readonly FieldArray[], grid: GridInfo, operation: string): void {
  const [c1, c2, c3] = inputs;
  if (c1 === undefined || c2 === undefined || c3 === undefined) return;
  requireCartesian(grid.geometry, operation);
  require3dVector(c1.data, c2.data, c3.data, c1.shape, operation);
  for (const [axis, samples] of c1.shape.entries()) {
    if (samples < 2) {
      throw new Error(`${operation}: axis ${axis} needs ≥2 samples (np.gradient), got ${samples}`);
    }
  }
  requirePositiveSpacing(grid.spacing, operation);
}

/**
 * Run recipe `name` on the WebGPU backend: gather its 3 component inputs, dispatch the bound WGSL
 * kernel, and package the result. Output is always `Float32Array` (the GPU is f32). Grid ops
 * (curl/divergence) validate the grid like the TS reference; the magnitude family ignores it.
 */
async function computeRecipeWebgpu(
  name: RecipeKey,
  dataset: FieldDataset,
  signal?: AbortSignal,
): Promise<FieldArray> {
  const recipe = RECIPES[name];
  const kernel = WEBGPU_FIELD_OPS[recipe.func];
  if (kernel === undefined) {
    throw new Error(`webgpu backend: no kernel bound for "${recipe.func}" (recipe "${name}")`);
  }

  const inputs = gatherRecipeInputs(recipe, name, dataset, "webgpu backend");
  const [c1, c2, c3] = inputs;
  if (c1 === undefined || c2 === undefined || c3 === undefined) {
    throw new Error(
      `webgpu backend: recipe "${name}" expects 3 component inputs, got ${inputs.length}`,
    );
  }

  if (kernel.needsGrid) validateGridOp(inputs, dataset.grid, `webgpu backend: ${recipe.func}`);

  const totalElements = c1.data.length;
  const params = buildKernelParams(
    c1.shape,
    dataset.grid.spacing,
    recipe.component ?? 0,
    totalElements,
  );
  const data = await runFieldKernel({
    device: getDevice(),
    wgsl: FIELD_OPS_WGSL,
    entryPoint: kernel.entryPoint,
    inputs: [toFloat32(c1.data), toFloat32(c2.data), toFloat32(c3.data)],
    params,
    outputElements: totalElements,
    signal,
  });

  return recipeFieldArray(name, data, c1);
}

// The WebGPU compute backend. `supports()` gates on a live device (false in Node and in workers,
// which can't hold the main thread's device). Proven against the coordinates twin first.
export const webgpuBackend: ComputeBackend = {
  id: "webgpu",
  supports: (recipe) => hasDevice() && isWebgpuOp(recipe),
  compute: computeRecipeWebgpu,
};
