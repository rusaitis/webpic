import type { FieldDataset } from "@containers/field_dataset.ts";
import {
  type AdaptiveTraceOptions,
  type FieldLine,
  traceFieldLinesAdaptive,
} from "@numerics/tracing.ts";
import type { Vec3 } from "@schema/types.ts";

export type { FieldLine } from "@numerics/tracing.ts";

// Field-line trace facade — the trace analogue of computeField. v0.1 runs the CPU DP5(4) tracer
// (numerics/tracing) synchronously on the main thread for a handful of seeds; M4.6 routes to the GPU
// streamline backend and threads an AbortSignal through here, the same shape as computeField prepending
// the WebGPU compute backend. Keeping the store→tracer hop behind this facade is the DAG-clean seam
// (store → compute, never store → numerics) and the single place M4.6 swaps the backend.
export function traceFields(
  dataset: FieldDataset,
  seeds: ReadonlyArray<Vec3>,
  options: AdaptiveTraceOptions = {},
): FieldLine[] {
  return traceFieldLinesAdaptive(dataset, seeds, options);
}
