import { displayTraceSteps, type FieldLine, traceFields, vectorComponentsForField } from "@compute";
import { errorMessage, logWarn } from "@schema/log.ts";
import type { SliceContext, TraceNotice } from "./state.ts";
import { createSupersedingTask } from "./supersedingTask.ts";

// Re-trace every field-line layer's seeds from the vector field its `field` names, publishing
// FieldLine[] + a TraceNotice per layer id. Seed failure is per seed, not per batch: a seed at a null
// or outside the domain is skipped and counted in the notice, so one bad seed in a rake cannot discard
// the rest. A per-layer try/catch still guards a genuine failure — a dataset without the components,
// a degenerate grid — recorded as the notice's `error`. Total (never rejects), so callers fire it
// with `void`.

export type Retrace = () => Promise<void>;

// A layer that never reached the tracer: nothing drawn, nothing classified, just the reason.
function failedNotice(requested: number, error: string): TraceNotice {
  return {
    requested,
    traced: 0,
    nullSeeds: 0,
    outsideSeeds: 0,
    failedSeeds: 0,
    fieldName: null,
    error,
  };
}

export function createRetrace({ get, set }: SliceContext): Retrace {
  return createSupersedingTask<[]>(async (run) => {
    const { dataset, layers, traces, traceNotices } = get();
    if (dataset === null) {
      // identity-skip when already empty
      if (Object.keys(traces).length > 0 || Object.keys(traceNotices).length > 0)
        set({ traces: {}, traceNotices: {} });
      return;
    }
    const next: Record<string, FieldLine[]> = {};
    const notices: Record<string, TraceNotice> = {};
    const steps = displayTraceSteps(dataset.grid);
    for (const layer of layers) {
      if (layer.kind !== "fieldlines") continue;
      const requested = layer.seeds.length;
      if (requested === 0) {
        // Commit the empty set so a cleared rake clears the scene — omitting the key would strand
        // the previous seeds' lines on screen. No notice: an empty layer is a state, not a finding.
        next[layer.id] = [];
        continue;
      }
      // Field lines follow the layer's own field; fall back to B when it names no stored vector
      // (a scalar like `beta`, or a derived family that was never materialized).
      const components =
        vectorComponentsForField(layer.field, dataset) ?? vectorComponentsForField("|B|", dataset);
      if (components === null) {
        notices[layer.id] = failedNotice(requested, `no vector field to trace for ${layer.field}`);
        next[layer.id] = [];
        continue;
      }
      try {
        const { lines, skipped, fieldName } = await traceFields(
          dataset,
          layer.seeds,
          { direction: "both", fieldComponents: components, ...steps },
          run.signal,
        );
        let nullSeeds = 0;
        let outsideSeeds = 0;
        let failedSeeds = 0;
        for (const skip of skipped) {
          if (skip.reason === "field_null") nullSeeds++;
          else if (skip.reason === "outside_domain") outsideSeeds++;
          else failedSeeds++;
        }
        // Commit even an empty set: the app clears a stale scene from the entry, not from its absence.
        next[layer.id] = lines;
        notices[layer.id] = {
          requested,
          traced: lines.length,
          nullSeeds,
          outsideSeeds,
          failedSeeds,
          fieldName,
          error: null,
        };
      } catch (error) {
        if (!run.isCurrent()) return; // superseded mid-trace — the newer retrace owns the commit
        logWarn("trace", `field-line trace failed for ${layer.id}`, error);
        next[layer.id] = [];
        notices[layer.id] = failedNotice(requested, errorMessage(error));
      }
    }
    if (!run.isCurrent()) return; // superseded between the last await and the commit
    // Identity-skip when nothing traced and nothing was traced before (no spurious subscriber fire).
    if (
      Object.keys(next).length === 0 &&
      Object.keys(traces).length === 0 &&
      Object.keys(traceNotices).length === 0
    )
      return;
    set({ traces: next, traceNotices: notices });
  });
}
