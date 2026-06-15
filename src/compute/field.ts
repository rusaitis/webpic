import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { ComputeBackend } from "./backend.ts";
import { tsBackend } from "./backends/ts/index.ts";
import { RECIPES, type RecipeKey } from "./recipes.generated.ts";

// Registered backends in selection-priority order (first supporting backend wins until calibration
// scoring lands). v0.1 ships the TS backend only; the WebGPU backend prepends here at M3 — the
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
  const backend = BACKENDS.find((candidate) => candidate.supports(RECIPES[key]));
  if (backend === undefined) {
    throw new Error(`computeField: no backend supports recipe "${name}"`);
  }
  return backend.compute(key, dataset, signal);
}

// The recipes computable from `dataset` right now: some backend binds the op AND its required input
// fields are all present. The selectable-field source for the UI (surfaced via the store, since `ui`
// can't import `compute`). Synchronous — a capability + presence query, not a compute.
export function computableFields(dataset: FieldDataset): RecipeKey[] {
  const present = dataset.fields;
  const names: RecipeKey[] = [];
  for (const [key, recipe] of Object.entries(RECIPES)) {
    if (recipe.fields.length === 0) continue;
    if (!BACKENDS.some((backend) => backend.supports(recipe))) continue;
    if (recipe.fields.every((field) => present.has(field))) {
      names.push(key as RecipeKey); // key ranges over RECIPES, so it is a RecipeKey
    }
  }
  return names.sort();
}
