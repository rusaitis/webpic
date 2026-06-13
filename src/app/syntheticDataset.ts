import type { FieldDataset } from "@containers/field_dataset.ts";
import { syntheticStep } from "@data";

// Scaffold: a deterministic in-memory B field so the app renders a real |B| volume with no data
// source wired. It's step 0 of the synthetic multi-step flux rope (data/readers/synthetic.ts), so
// the main-thread seed here and the worker's streamed step 0 are bit-identical (no flash on
// scrub-back to 0). `n` is the per-axis resolution (n³ cells); the default is the small render
// scaffold, while a larger `n` (e.g. 256) feeds the 256³ raymarch gate / profiling.
export function createSyntheticDataset(n = 32): FieldDataset {
  return syntheticStep(n, 0, 1); // step 0 (phase 0): no drift, unit amplitude — the static rope
}
