import type { FieldDataset } from "@containers/field_dataset.ts";
import {
  type AdaptiveTraceOptions,
  type FieldLine,
  traceFieldLinesAdaptive,
} from "@numerics/tracing.ts";
import type { Vec3 } from "@schema/types.ts";

export type { FieldLine } from "@numerics/tracing.ts";

// Field-line trace facade — the trace analogue of computeField, same `(…, signal?)` shape. Threads an
// AbortSignal into the CPU DP5(4) tracer (numerics/tracing), which checks it per integration step; a
// superseded trace aborts mid-line once the tracer runs off-main. Async so the contract is stable for
// the deferred GPU/worker backend — routing to the WebGPU streamline tracer (traceFieldLinesWebgpu)
// stays deferred until a main-thread GPUDevice exists (the worker-reads/main-computes device seam).
// Keeping the store→tracer hop behind this facade is the DAG-clean seam (store → compute, never
// store → numerics) and the single place to swap the backend.
export async function traceFields(
  dataset: FieldDataset,
  seeds: ReadonlyArray<Vec3>,
  options: AdaptiveTraceOptions = {},
  signal?: AbortSignal,
): Promise<FieldLine[]> {
  signal?.throwIfAborted();
  return traceFieldLinesAdaptive(dataset, seeds, options, signal);
}
