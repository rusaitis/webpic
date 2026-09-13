import {
  displayTraceSteps,
  type FieldLine,
  type TraceSkip,
  traceFields,
  vectorComponentsForField,
} from "@compute";
import type { FieldDataset } from "@containers/field_dataset.ts";
import { errorMessage, logWarn } from "@schema/log.ts";
import { isTracingLayer, type TracingLayer } from "./layerKinds.ts";
import type { SliceContext, TraceNotice } from "./state.ts";
import { createSupersedingTask, type TaskRun } from "./supersedingTask.ts";

// Re-trace every field-line layer's seeds from the vector field its `field` names, publishing
// FieldLine[] + a TraceNotice per layer id. Seed failure is per seed, not per batch: a seed at a null
// or outside the domain is skipped and counted in the notice, so one bad seed in a rake cannot discard
// the rest. A per-layer try/catch still guards a genuine failure — a dataset without the components,
// a degenerate grid — recorded as the notice's `error`. Total (never rejects), so callers fire it
// with `void`.

export type Retrace = () => Promise<void>;

type TraceSteps = ReturnType<typeof displayTraceSteps>;

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

// How a batch's skipped seeds split across the rejection reasons. Keyed on TraceSkipReason rather
// than `string`: a fourth reason is then a compile error here instead of a silent tally under
// failedSeeds, which the field-lines panel reports to the user as a trace failure.
function tallySkips(skipped: readonly TraceSkip[]): {
  nullSeeds: number;
  outsideSeeds: number;
  failedSeeds: number;
} {
  let nullSeeds = 0;
  let outsideSeeds = 0;
  let failedSeeds = 0;
  for (const skip of skipped) {
    switch (skip.reason) {
      case "field_null":
        nullSeeds++;
        break;
      case "outside_domain":
        outsideSeeds++;
        break;
      case "trace_failed":
        failedSeeds++;
        break;
      default:
        skip.reason satisfies never; // the tracer's union is the only source
        break;
    }
  }
  return { nullSeeds, outsideSeeds, failedSeeds };
}

// One layer's lines plus the notice describing them; `notice` is null for an empty rake, which is a
// state rather than a finding. `null` for the whole result means the run was superseded mid-trace,
// so the caller must abandon its commit to the newer one.
type LayerTrace = { readonly lines: FieldLine[]; readonly notice: TraceNotice | null } | null;

async function traceLayer(
  layer: TracingLayer,
  dataset: FieldDataset,
  steps: TraceSteps,
  run: TaskRun,
): Promise<LayerTrace> {
  const requested = layer.seeds.length;
  // Commit the empty set so a cleared rake clears the scene — omitting the key would strand the
  // previous seeds' lines on screen.
  if (requested === 0) return { lines: [], notice: null };

  // Field lines follow the layer's own field; fall back to B when it names no stored vector
  // (a scalar like `beta`, or a derived family that was never materialized).
  const components =
    vectorComponentsForField(layer.field, dataset) ?? vectorComponentsForField("|B|", dataset);
  if (components === null) {
    return {
      lines: [],
      notice: failedNotice(requested, `no vector field to trace for ${layer.field}`),
    };
  }

  try {
    const { lines, skipped, fieldName } = await traceFields(
      dataset,
      layer.seeds,
      { direction: "both", fieldComponents: components, ...steps },
      run.signal,
    );
    // Commit even an empty set: the app clears a stale scene from the entry, not from its absence.
    return {
      lines,
      notice: { requested, traced: lines.length, ...tallySkips(skipped), fieldName, error: null },
    };
  } catch (error) {
    if (!run.isCurrent()) return null; // superseded mid-trace — the newer retrace owns the commit
    logWarn("trace", `field-line trace failed for ${layer.id}`, error);
    return { lines: [], notice: failedNotice(requested, errorMessage(error)) };
  }
}

// True when the commit would publish nothing over nothing — a set() then would wake every trace
// subscriber for no change.
const isEmptyCommit = (...maps: ReadonlyArray<Record<string, unknown>>): boolean =>
  maps.every((map) => Object.keys(map).length === 0);

export function createRetrace({ get, set }: SliceContext): Retrace {
  return createSupersedingTask<[]>(async (run) => {
    const { dataset, layers, traces, traceNotices } = get();
    if (dataset === null) {
      if (!isEmptyCommit(traces, traceNotices)) set({ traces: {}, traceNotices: {} });
      return;
    }
    const next: Record<string, FieldLine[]> = {};
    const notices: Record<string, TraceNotice> = {};
    const steps = displayTraceSteps(dataset.grid);
    for (const layer of layers) {
      if (!isTracingLayer(layer)) continue;
      const traced = await traceLayer(layer, dataset, steps, run);
      if (traced === null) return;
      next[layer.id] = traced.lines;
      if (traced.notice !== null) notices[layer.id] = traced.notice;
    }
    if (!run.isCurrent()) return; // superseded between the last await and the commit
    if (isEmptyCommit(next, traces, traceNotices)) return;
    set({ traces: next, traceNotices: notices });
  });
}
