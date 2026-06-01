import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import { computeRecipeTs } from "./backends/ts/index.ts";
import { RECIPES, type RecipeKey } from "./recipes.generated.ts";

// Public compute entry point. Validates the recipe name against the canonical registry
// and rejects unknown names loudly (mirrors pypic's KeyError — a silent miss gets swallowed
// in notebooks). TS backend only for now; the async WebGPU dispatcher (M3) slots in at the
// store/dispatcher boundary, not here, so this stays a synchronous typed wrapper.
export function computeField(name: string, dataset: FieldDataset): FieldArray {
  if (!Object.hasOwn(RECIPES, name)) {
    throw new Error(`computeField: unknown recipe "${name}"`);
  }
  // Object.hasOwn guarantees membership but doesn't narrow the string; the cast is sound.
  return computeRecipeTs(name as RecipeKey, dataset);
}
