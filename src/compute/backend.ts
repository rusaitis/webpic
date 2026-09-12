import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { RecipeMeta } from "./recipe.ts";
import type { RecipeKey } from "./recipes.generated.ts";

// A pluggable compute backend: it binds the codegen'd recipe `func` names to one engine's kernels and
// reports which recipes it can evaluate. `compute` is async to admit GPU dispatch + readback — the TS
// backend resolves immediately, but the uniform Promise lets an async backend share the dispatcher.
// The dispatcher picks the first registered backend that `supports` a recipe; a `context.prefer`
// override + calibration scoring refine that once more than one qualifies (DESIGN §Compute dispatcher).
// `BackendId` is the id universe — calibration's runtime Zod enum derives from it, so there is no skew.
export const BACKEND_IDS = ["ts", "wasm", "webgpu"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

export interface ComputeBackend {
  readonly id: BackendId;
  /** Can this backend evaluate the recipe at all — a bound op plus the feature flags it needs? */
  supports(recipe: RecipeMeta): boolean;
  /** Evaluate the recipe against the dataset; honors `signal` for cancellation (e.g. GPU traces). */
  compute(name: RecipeKey, dataset: FieldDataset, signal?: AbortSignal): Promise<FieldArray>;
}
