import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import { computeRecipeTs, isTsComputable } from "./backends/ts/index.ts";
import { RECIPES, type RecipeKey } from "./recipes.generated.ts";

// Public compute entry point. Validates the recipe name against the canonical registry and rejects
// unknown names loudly (mirrors pypic's KeyError — a silent miss gets swallowed in notebooks). TS
// backend only for now, so this stays a synchronous typed wrapper (the WebGPU dispatcher slots in at
// the store boundary).
export function computeField(name: string, dataset: FieldDataset): FieldArray {
  if (!Object.hasOwn(RECIPES, name)) {
    throw new Error(`computeField: unknown recipe "${name}"`);
  }
  // Object.hasOwn guarantees membership but doesn't narrow the string; the cast is sound.
  return computeRecipeTs(name as RecipeKey, dataset);
}

// The recipes computable from `dataset` right now: a bound (TS) op whose required input fields are
// all present. The selectable-field source for the UI (surfaced via the store, since `ui` can't
// import `compute`).
export function computableFields(dataset: FieldDataset): RecipeKey[] {
  const present = dataset.fields;
  const names: RecipeKey[] = [];
  for (const [key, recipe] of Object.entries(RECIPES)) {
    if (!isTsComputable(recipe) || recipe.fields.length === 0) continue;
    if (recipe.fields.every((field) => present.has(field))) {
      names.push(key as RecipeKey); // key ranges over RECIPES, so it is a RecipeKey
    }
  }
  return names.sort();
}
