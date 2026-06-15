import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";
import type { FloatArray } from "@schema/types.ts";
import type { ComputeBackend } from "../../backend.ts";
import type { RecipeMeta } from "../../recipe.ts";
import { RECIPES, type RecipeKey } from "../../recipes.generated.ts";
import { MAGNITUDE_FIELD_OPS } from "./magnitude.ts";

export type TsFieldOp = (inputs: readonly FieldArray[]) => FloatArray;

// func-name → TS implementation. Each backend binds the codegen'd recipe `func` strings to
// its own kernels; the WebGPU backend binds the same names to WGSL.
const TS_FIELD_OPS: Record<string, TsFieldOp> = { ...MAGNITUDE_FIELD_OPS };

// Can the TS backend evaluate this recipe at all (bound op, no unsupported features)? Keep in sync
// with computeRecipeTs's guards below — it builds the selectable-field list without attempting a
// compute per candidate.
export function isTsComputable(recipe: RecipeMeta): boolean {
  return (
    !recipe.needsGrid &&
    !recipe.needsGamma &&
    !recipe.needsC &&
    recipe.component === null &&
    recipe.speciesArgs === null &&
    Object.hasOwn(TS_FIELD_OPS, recipe.func)
  );
}

function sameShape(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Run recipe `name` on the TS backend: gather its inputs from `dataset`, run the bound op,
 * and package the result as a `FieldArray` (magnitude preserves component units; output meta
 * comes from the canonical registry). Supports the flag-free magnitude family — recipes
 * needing grid/gamma/c, a component slice, or species args throw until those ops land.
 */
export function computeRecipeTs(name: RecipeKey, dataset: FieldDataset): FieldArray {
  const recipe = RECIPES[name];
  if (
    recipe.needsGrid ||
    recipe.needsGamma ||
    recipe.needsC ||
    recipe.component !== null ||
    recipe.speciesArgs !== null
  ) {
    throw new Error(
      `ts backend: recipe "${name}" needs features the TS backend does not support yet`,
    );
  }
  const op = TS_FIELD_OPS[recipe.func];
  if (op === undefined) {
    throw new Error(`ts backend: no TS op bound for "${recipe.func}" (recipe "${name}")`);
  }

  const inputs: FieldArray[] = [];
  for (const fieldName of recipe.fields) {
    const field = dataset.fields.get(fieldName);
    if (field === undefined) {
      throw new Error(`ts backend: recipe "${name}" requires field "${fieldName}", not in dataset`);
    }
    const first = inputs[0];
    if (first !== undefined && !sameShape(first.shape, field.shape)) {
      throw new Error(`ts backend: recipe "${name}" inputs have mismatched shapes`);
    }
    inputs.push(field);
  }
  const first = inputs[0];
  if (first === undefined) {
    throw new Error(`ts backend: recipe "${name}" has no input fields`);
  }

  const data = op(inputs);
  const meta = fieldInfo(name);
  return { data, shape: first.shape, meta, units: first.units, latex: meta.latex, reduction: null };
}

// The TS reference backend as a ComputeBackend: the synchronous magnitude family behind the async
// facade. `Promise.resolve` keeps the dispatcher uniform with the async WebGPU backend (M3) — the work
// itself still runs synchronously on call, so a streamed step pays no extra hop.
export const tsBackend: ComputeBackend = {
  id: "ts",
  supports: isTsComputable,
  compute(name, dataset) {
    return Promise.resolve(computeRecipeTs(name, dataset));
  },
};
