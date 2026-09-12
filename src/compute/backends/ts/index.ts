import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { sameShape } from "@schema/math.ts";
import { fieldInfo } from "@schema/registry.ts";
import type { FloatArray } from "@schema/types.ts";
import type { ComputeBackend } from "../../backend.ts";
import type { RecipeMeta } from "../../recipe.ts";
import { RECIPES, type RecipeKey } from "../../recipes.generated.ts";
import { MAGNITUDE_FIELD_OPS } from "./magnitude.ts";
import { OPERATOR_FIELD_OPS } from "./operators.ts";

// The grid + component context a field op needs beyond its inputs. The magnitude family ignores it;
// curl/divergence read spacing + geometry from the grid (and curl its component index).
interface TsOpContext {
  readonly shape: readonly number[];
  readonly grid: GridInfo;
  readonly component: number | null;
}

export type TsFieldOp = (inputs: readonly FieldArray[], context: TsOpContext) => FloatArray;

// func-name → TS implementation. Each backend binds the codegen'd recipe `func` strings to its own
// kernels; the WebGPU backend binds the same names to WGSL. The op set mirrors the WGSL backend's, so
// the two stay symmetric (the cross-backend equivalence harness leans on that).
const TS_FIELD_OPS: Record<string, TsFieldOp> = { ...MAGNITUDE_FIELD_OPS, ...OPERATOR_FIELD_OPS };

// Can the TS backend evaluate this recipe at all (a bound op, and none of the feature flags no TS op
// supports)? Mirrors isWebgpuOp: grid + component are fine now (curl/divergence carry them) — only
// gamma/c/species recipes stay out of scope. Keep in sync with computeRecipeTs's guard below — it
// builds the selectable-field list without attempting a compute per candidate.
export function isTsComputable(recipe: RecipeMeta): boolean {
  return (
    !recipe.needsGamma &&
    !recipe.needsC &&
    recipe.speciesArgs === null &&
    Object.hasOwn(TS_FIELD_OPS, recipe.func)
  );
}

/**
 * Run recipe `name` on the TS backend: gather its inputs from `dataset`, run the bound op,
 * and package the result as a `FieldArray` (output preserves component units; output meta comes from
 * the canonical registry). Supports the magnitude family plus curl/divergence — the grid ops validate
 * the grid in the `coordinates/` layer they delegate to. Recipes needing gamma/c or species args throw
 * until those ops land.
 */
export function computeRecipeTs(name: RecipeKey, dataset: FieldDataset): FieldArray {
  const recipe = RECIPES[name];
  if (recipe.needsGamma || recipe.needsC || recipe.speciesArgs !== null) {
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

  const data = op(inputs, { shape: first.shape, grid: dataset.grid, component: recipe.component });
  const meta = fieldInfo(name);
  return { data, shape: first.shape, meta, units: first.units, latex: meta.latex, reduction: null };
}

// The TS reference backend as a ComputeBackend: the synchronous reference ops behind the async facade.
// `Promise.resolve` keeps the dispatcher uniform with the async WebGPU backend — the work itself still
// runs synchronously on call, so a streamed step pays no extra hop.
export const tsBackend: ComputeBackend = {
  id: "ts",
  supports: isTsComputable,
  compute(name, dataset) {
    return Promise.resolve(computeRecipeTs(name, dataset));
  },
};
