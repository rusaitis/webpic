import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { runFieldKernel } from "@gpu/computeKernel.ts";
import { getDevice, hasDevice } from "@gpu/device.ts";
import { sameShape } from "@schema/math.ts";
import { fieldInfo } from "@schema/registry.ts";
import {
  CURL_ENTRY,
  DIVERGENCE_ENTRY,
  FIELD_OPS_WGSL,
  MAGNITUDE_ENTRY,
} from "@shaders/kernels/fieldOps.wgsl.ts";
import type { ComputeBackend } from "../../backend.ts";
import type { RecipeMeta } from "../../recipe.ts";
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

// Mirror the coordinates/operators.ts guards so a grid op fails the same way on the GPU path: the
// reference rejects non-cartesian geometry, <3D grids, <2 samples per axis (np.gradient needs the
// neighbour), and non-positive spacing.
function validateGridOp(shape: readonly number[], grid: GridInfo, func: string): void {
  if (grid.geometry !== "cartesian") {
    throw new Error(`webgpu backend: ${func} ${grid.geometry} geometry not implemented`);
  }
  if (shape.length !== 3) {
    throw new Error(`webgpu backend: ${func} expects a 3D grid, got ${shape.length}D`);
  }
  for (const dim of shape) {
    if (dim < 2) throw new Error(`webgpu backend: ${func} needs ≥2 samples per axis (np.gradient)`);
  }
  for (const d of grid.spacing) {
    // `!(d > 0)` also rejects NaN spacing — matches requirePositiveSpacing.
    if (!(d > 0))
      throw new Error(`webgpu backend: ${func} grid spacing must be positive, got ${d}`);
  }
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

  const inputs: FieldArray[] = [];
  for (const fieldName of recipe.fields) {
    const field = dataset.fields.get(fieldName);
    if (field === undefined) {
      throw new Error(
        `webgpu backend: recipe "${name}" requires field "${fieldName}", not in dataset`,
      );
    }
    const first = inputs[0];
    if (first !== undefined && !sameShape(first.shape, field.shape)) {
      throw new Error(`webgpu backend: recipe "${name}" inputs have mismatched shapes`);
    }
    inputs.push(field);
  }
  const [c1, c2, c3] = inputs;
  if (c1 === undefined || c2 === undefined || c3 === undefined) {
    throw new Error(
      `webgpu backend: recipe "${name}" expects 3 component inputs, got ${inputs.length}`,
    );
  }

  if (kernel.needsGrid) validateGridOp(c1.shape, dataset.grid, recipe.func);

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

  const meta = fieldInfo(name);
  return { data, shape: c1.shape, meta, units: c1.units, latex: meta.latex, reduction: null };
}

// The WebGPU compute backend. `supports()` gates on a live device (false in Node and in workers,
// which can't hold the main thread's device). NOT registered in `compute/field.ts`'s dispatcher
// yet — live routing needs the data worker to read raw components and hand GPU compute to the main
// thread (a worker has no GPUDevice). Built + proven against the coordinates twin first.
export const webgpuBackend: ComputeBackend = {
  id: "webgpu",
  supports: (recipe) => hasDevice() && isWebgpuOp(recipe),
  compute: computeRecipeWebgpu,
};
