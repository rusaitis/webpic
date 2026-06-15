import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { RecipeMeta } from "./recipe.ts";
import type { RecipeKey } from "./recipes.generated.ts";

// A pluggable compute backend: it binds the codegen'd recipe `func` names to one engine's kernels (the
// TS reference ops today; standalone WGSL at M3; `@rustpic/plasma-wasm` at M9) and reports which recipes
// it can evaluate. `compute` is async to admit GPU dispatch + readback — the TS backend resolves
// immediately, but the uniform Promise lets an async backend share the dispatcher without the sync ones
// faking a hop. The dispatcher (computeField) picks the first registered backend that `supports` a
// recipe; a `ctx.prefer` override + calibration scoring (DESIGN §compute) will refine the choice once
// more than one backend qualifies.
export type BackendId = "ts" | "wasm" | "webgpu";

export interface ComputeBackend {
  readonly id: BackendId;
  /** Can this backend evaluate the recipe at all — a bound op plus the feature flags it needs? */
  supports(recipe: RecipeMeta): boolean;
  /** Evaluate the recipe against the dataset; honors `signal` for cancellation (GPU traces, M3+). */
  compute(name: RecipeKey, dataset: FieldDataset, signal?: AbortSignal): Promise<FieldArray>;
}
