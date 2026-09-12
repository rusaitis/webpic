import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import type { ComputeBackend } from "./backend.ts";
import { tsBackend } from "./backends/ts/index.ts";
import type { RecipeMeta } from "./recipe.ts";
import { RECIPES, type RecipeKey } from "./recipes.generated.ts";

// Registered backends in selection-priority order (first supporting backend wins until calibration
// scoring lands). v0.1 ships the TS backend only; the WebGPU backend prepends here — the
// dispatcher and every caller (store recompute, the data worker) are already async, so it just slots in.
const BACKENDS: readonly ComputeBackend[] = [tsBackend];

// Public compute entry point. Validates the recipe name against the canonical registry and rejects
// unknown names loudly (mirrors pypic's KeyError — a silent miss gets swallowed in notebooks) —
// *synchronously*, so a typo fails at the call site, not as a swallowed rejection. The compute itself
// is async (a backend may dispatch to the GPU); the TS backend resolves immediately.
export function computeField(
  name: string,
  dataset: FieldDataset,
  signal?: AbortSignal,
): Promise<FieldArray> {
  if (!Object.hasOwn(RECIPES, name)) {
    throw new Error(`computeField: unknown recipe "${name}"`);
  }
  // Object.hasOwn guarantees membership but doesn't narrow the string; the cast is sound.
  const key = name as RecipeKey;
  const recipe = RECIPES[key];
  const backend = BACKENDS.find((candidate) => candidate.supports(recipe));
  if (backend === undefined) {
    throw new Error(`computeField: no backend supports recipe "${name}"`);
  }
  // The same predicate computableFields filters on, so what the selector hides the dispatcher
  // refuses — and a reduced dataset fails here, named, instead of deep inside partialAlongAxis.
  if (!gridCanEvaluate(recipe, dataset.grid)) {
    const { geometry, dimensions } = dataset.grid;
    throw new Error(
      `computeField: recipe "${name}" needs a 3-D cartesian grid with ≥2 samples per axis, got ${geometry} [${dimensions.join(", ")}]`,
    );
  }
  return backend.compute(key, dataset, signal);
}

// A needsGrid recipe (curl/divergence) is only evaluable on a 3-D Cartesian grid with the ≥2
// samples/axis np.gradient needs. The single grid predicate: computeField rejects on it, and
// computableFields filters on it, so the selector never offers an op the dispatcher would refuse.
function gridCanEvaluate(recipe: RecipeMeta, grid: GridInfo): boolean {
  if (!recipe.needsGrid) return true;
  return (
    grid.geometry === "cartesian" &&
    grid.dimensions.length === 3 &&
    grid.dimensions.every((dim) => dim >= 2)
  );
}

// The recipes computable from `dataset` right now: some backend binds the op, the grid can evaluate it,
// AND its required input fields are all present. The selectable-field source for the UI (surfaced via
// the store, since `ui` can't import `compute`). Synchronous — a capability + presence query, not a compute.
export function computableFields(dataset: FieldDataset): RecipeKey[] {
  const present = dataset.fields;
  const names: RecipeKey[] = [];
  for (const [key, recipe] of Object.entries(RECIPES)) {
    if (recipe.fields.length === 0) continue;
    if (!BACKENDS.some((backend) => backend.supports(recipe))) continue;
    if (!gridCanEvaluate(recipe, dataset.grid)) continue;
    if (recipe.fields.every((field) => present.has(field))) {
      names.push(key as RecipeKey); // key ranges over RECIPES, so it is a RecipeKey
    }
  }
  return names.sort();
}
