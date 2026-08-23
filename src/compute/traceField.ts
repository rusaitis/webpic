import type { FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { interpolatorFromDataset } from "@numerics/interp.ts";
import {
  type AdaptiveTraceOptions,
  DEFAULT_MAX_STEP,
  DEFAULT_STEP_SIZE_INIT,
  type FieldLine,
  partitionSeeds,
  resolveTraceParams,
  type SeedPoint,
  type SeedRejection,
  toSeedList,
  traceFieldLineAdaptive,
  traceFieldLinesAdaptive,
} from "@numerics/tracing.ts";
import type { FieldName, Vec3 } from "@schema/types.ts";
import type { RecipeMeta } from "./recipe.ts";
import { RECIPES } from "./recipes.generated.ts";

export type { FieldLine, SeedRejection, SkippedSeed } from "@numerics/tracing.ts";

/** Why a seed produced no line: it couldn't start one, or the trace itself failed (a seed whose
 *  very first step leaves the domain both ways yields a 1-point line, which is no line at all). */
export type TraceSkipReason = SeedRejection | "trace_failed";

export interface TraceSkip {
  readonly index: number;
  readonly seed: SeedPoint;
  readonly reason: TraceSkipReason;
}

/** A batch trace: the lines that ran, the seeds that produced none, and the vector they followed
 *  (known even when nothing traced — that's the case worth explaining). */
export interface TraceBatchResult {
  readonly lines: FieldLine[];
  readonly skipped: readonly TraceSkip[];
  readonly fieldName: string;
}

export interface TraceFieldsOptions extends AdaptiveTraceOptions {
  /** Policy for a seed at a field null / outside the domain. `"skip"` (default) traces the rest and
   *  reports it; `"throw"` restores the strict pypic-mirroring batch contract of `numerics/tracing`. */
  readonly onInvalidSeed?: "skip" | "throw";
}

// Field-line trace facade — the trace analogue of computeField, same `(…, signal?)` shape. Threads an
// AbortSignal into the CPU DP5(4) tracer (numerics/tracing), which checks it per integration step; a
// superseded trace aborts mid-line once the tracer runs off-main. Async so the contract is stable for
// the deferred GPU/worker backend — routing to the WebGPU streamline tracer (traceFieldLinesWebgpu)
// stays deferred until a main-thread GPUDevice exists (the worker-reads/main-computes device seam).
// Keeping the store→tracer hop behind this facade is the DAG-clean seam (store → compute, never
// store → numerics) and the single place to swap the backend. The skip policy lives here rather than
// in numerics (which keeps pypic's strict validate-then-throw batch), so it will cover the WebGPU
// tracer once traceFieldLinesWebgpu routes through here — that one still validates strictly today.
export async function traceFields(
  dataset: FieldDataset,
  seeds: ReadonlyArray<Vec3>,
  options: TraceFieldsOptions = {},
  signal?: AbortSignal,
): Promise<TraceBatchResult> {
  signal?.throwIfAborted();
  const { onInvalidSeed = "skip", ...traceOptions } = options;
  const resolved = resolveTraceParams(dataset, traceOptions);
  if (onInvalidSeed === "throw") {
    return {
      lines: traceFieldLinesAdaptive(dataset, seeds, traceOptions, signal),
      skipped: [],
      fieldName: resolved.fieldName,
    };
  }
  const interp = traceOptions.interpolator ?? interpolatorFromDataset(dataset, resolved.components);
  const { traceable, skipped } = partitionSeeds(interp, toSeedList(seeds), resolved.nullThreshold);
  const lines: FieldLine[] = [];
  const dropped: TraceSkip[] = [...skipped];
  // Seed by seed, not one batch call: a validated seed can still fail mid-trace (a first step that
  // leaves the domain in both directions yields a 1-point line, which the FieldLine invariant
  // rejects), and that must cost one line, not the whole set.
  for (const { index, seed } of traceable) {
    try {
      lines.push(
        traceFieldLineAdaptive(dataset, seed, { ...traceOptions, interpolator: interp }, signal),
      );
    } catch {
      signal?.throwIfAborted(); // a cancel is not a skipped seed — let it propagate
      dropped.push({
        index,
        seed: [seed[0] ?? 0, seed[1] ?? 0, seed[2] ?? 0],
        reason: "trace_failed",
      });
    }
  }
  return { lines, skipped: dropped, fieldName: resolved.fieldName };
}

// RECIPES is keyed by RecipeKey; a display field name is an arbitrary string, so widen the index
// rather than assert an unchecked key.
const RECIPE_BY_NAME = RECIPES as Readonly<Record<string, RecipeMeta | undefined>>;

const COMPONENT_NAME = /^(.+)_([123])$/;

// A magnitude's recipe lists its vector components first (the `_perp` magnitudes carry B after them),
// so the family is the leading triple — when it really is one: same root, components 1/2/3 in order.
function familyOf(names: readonly string[]): readonly [string, string, string] | null {
  const [a, b, c] = names;
  if (a === undefined || b === undefined || c === undefined) return null;
  const match = COMPONENT_NAME.exec(a);
  const root = match?.[1];
  if (root === undefined || match?.[2] !== "1") return null;
  return b === `${root}_2` && c === `${root}_3` ? [a, b, c] : null;
}

/**
 * The vector components a displayed field's lines should follow — `'|B|'` → `B_1/B_2/B_3`, `'|E|'` →
 * `E_1/E_2/E_3`, a bare component `B_2` → its own family. `null` when the field names no vector the
 * dataset carries (`beta`, `P`, a derived family that was never materialized), leaving the choice of
 * fallback to the caller. A perpendicular magnitude resolves to its unprojected family (`'|E_perp|'`
 * → E), which is the vector actually stored.
 */
export function vectorComponentsForField(
  field: FieldName,
  dataset: FieldDataset,
): readonly [string, string, string] | null {
  const direct = COMPONENT_NAME.exec(field);
  const root = direct?.[1];
  const candidate =
    root !== undefined
      ? familyOf([`${root}_1`, `${root}_2`, `${root}_3`])
      : field.startsWith("|") && field.endsWith("|")
        ? familyOf(RECIPE_BY_NAME[field]?.fields ?? [])
        : null;
  if (candidate === null) return null;
  return candidate.every((name) => dataset.fields.has(name)) ? candidate : null;
}

// Display traces want a step that resolves the *domain*, not pypic's absolute default: the dipole
// spans 15 R_E, so a 2.0 cap renders 3–13-point polylines. Refines only — never coarser than pypic.
const DISPLAY_STEP_FRACTION = 0.02;

/**
 * Step limits for traces that will be *drawn*: max step ~2% of the domain diagonal, capped at pypic's
 * default, with the initial step pulled down to match (the first step is taken before the controller
 * clamps, so leaving it at 0.5 would put one oversized segment at every seed). Keeps `numerics`'
 * pypic-mirroring defaults untouched — this is a rendering choice, not a physics one.
 */
export function displayTraceSteps(grid: GridInfo): {
  readonly maxStep: number;
  readonly stepSizeInit: number;
} {
  let diagonalSq = 0;
  // Unlike seedPick's axisSpan there is no voxel-index fallback: an unusable spacing falls through to
  // the pypic default below rather than inventing a domain size.
  for (let i = 0; i < 3; i++) {
    const span = (grid.dimensions[i] ?? 0) * (grid.spacing[i] ?? 0);
    diagonalSq += span * span;
  }
  const scaled = DISPLAY_STEP_FRACTION * Math.sqrt(diagonalSq);
  const maxStep =
    scaled > 0 && Number.isFinite(scaled) ? Math.min(DEFAULT_MAX_STEP, scaled) : DEFAULT_MAX_STEP;
  return { maxStep, stepSizeInit: Math.min(DEFAULT_STEP_SIZE_INIT, maxStep) };
}
