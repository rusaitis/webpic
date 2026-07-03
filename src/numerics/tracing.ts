// Adaptive field-line tracing — integrates dr/ds = B̂(r) with the Dormand-Prince 5(4) step from
// ./integrators.ts, arc-length parameterized. Mirrors pypic.traces (trace_field_line[s]_adaptive,
// TerminationReason, FieldLine + the closed-loop arc-length gate). Pure leaf — typed arrays in/out,
// no THREE/DOM/GPU; imports only @containers types + the same-layer integrator/interpolator.
//
// The vectorized multi-seed DP kernel is deferred to the GPU (M4.3 WGSL twin); traceFieldLinesAdaptive
// here loops the single-seed tracer with a shared interpolator — the CPU-available slice of pypic's
// batching win. `?? 0` on the buffer reads only satisfies noUncheckedIndexedAccess; every index is in
// bounds by construction.

import type { FieldDataset, Normalization } from "@containers/field_dataset.ts";
import {
  dormandPrinceStep,
  embeddedErrorNorm,
  iStepController,
  type Rhs,
  type StepControl,
} from "./integrators.ts";
import { interpolatorFromDataset, type VectorFieldInterpolator } from "./interp.ts";

// Seed coordinates are PHYSICAL grid positions (schema-import-free layer: not @schema's Vec3).
export type SeedPoint = readonly [number, number, number];

export type TraceDirection = "forward" | "backward" | "both";

/** Why a trace stopped — string-literal mirror of pypic's `TerminationReason` StrEnum values. */
export type TerminationReason =
  | "max_steps"
  | "domain_exit"
  | "null_point"
  | "callback"
  | "closed_loop";

/**
 * Integer codes for `TerminationReason`, the single source the WGSL streamline kernel writes into its
 * `meta` buffer and the GPU orchestrator decodes back. `callback` (3) is CPU-only — a JS predicate isn't
 * GPU-expressible, so the kernel never emits it. The `satisfies` keeps every reason mapped.
 */
export const REASON_CODES = {
  max_steps: 0,
  domain_exit: 1,
  null_point: 2,
  callback: 3,
  closed_loop: 4,
} as const satisfies Record<TerminationReason, number>;

const REASON_BY_CODE: readonly TerminationReason[] = [
  "max_steps",
  "domain_exit",
  "null_point",
  "callback",
  "closed_loop",
];

/** Decode a `REASON_CODES` integer (e.g. from the GPU `meta` buffer) back to a `TerminationReason`. */
export function reasonFromCode(code: number): TerminationReason {
  const reason = REASON_BY_CODE[code];
  if (reason === undefined) throw new Error(`unknown termination reason code ${code}`);
  return reason;
}

export interface TraceMetadata {
  readonly method: "rk45_dopri";
  readonly atol: number;
  readonly rtol: number;
  readonly maxLocalError: number;
  readonly reason: TerminationReason;
  readonly nSteps: number;
}

/**
 * An ordered, arc-length-parameterized field line. Mirrors pypic's `FieldLine`. `points` is flat
 * row-major (N, 3) — point i at `[3i, 3i+1, 3i+2]`, N ≥ 2. `scalars` is empty in v0.1 (no along-line
 * sampling yet); `time` is null (webpic carries no absolute time).
 */
export interface FieldLine {
  readonly points: Float64Array;
  readonly nPoints: number;
  readonly fieldName: string;
  readonly seedPoint: SeedPoint;
  readonly normalization: Normalization;
  readonly step: number | null;
  readonly time: number | null;
  readonly direction: TraceDirection;
  readonly scalars: ReadonlyMap<string, Float64Array>;
  readonly reason: TerminationReason;
  readonly metadata: TraceMetadata;
}

const DEFAULT_COMPONENTS = ["B_1", "B_2", "B_3"] as const;

export interface AdaptiveTraceOptions {
  readonly atol?: number;
  readonly rtol?: number;
  readonly stepSizeInit?: number;
  readonly minStep?: number;
  readonly maxStep?: number;
  readonly maxSteps?: number;
  readonly direction?: TraceDirection;
  readonly fieldComponents?: readonly [string, string, string];
  readonly nullThreshold?: number;
  readonly terminate?: (point: Float64Array) => boolean;
  /** Closed-loop proximity threshold (code units). `"auto"` → `0.5·min(spacing)`; `null` disables. */
  readonly loopTol?: number | null | "auto";
  readonly loopMinArclen?: number | null;
  readonly interpolator?: VectorFieldInterpolator;
}

/**
 * Assemble a `FieldLine`, enforcing pypic's `__post_init__` invariants: points length a multiple of 3,
 * N ≥ 2, every scalar of length N. Exported so callers (and tests) get the same guard the tracer uses.
 */
export function makeFieldLine(args: {
  readonly points: Float64Array;
  readonly fieldName: string;
  readonly seedPoint: SeedPoint;
  readonly normalization: Normalization;
  readonly direction: TraceDirection;
  readonly reason: TerminationReason;
  readonly atol: number;
  readonly rtol: number;
  readonly maxLocalError: number;
  readonly step?: number | null;
  readonly time?: number | null;
  readonly scalars?: ReadonlyMap<string, Float64Array>;
}): FieldLine {
  const { points } = args;
  if (points.length % 3 !== 0) {
    throw new Error(`field-line points length ${points.length} is not a multiple of 3`);
  }
  const nPoints = points.length / 3;
  if (nPoints < 2) throw new Error(`field line needs ≥ 2 points, got ${nPoints}`);
  const scalars: ReadonlyMap<string, Float64Array> =
    args.scalars ?? new Map<string, Float64Array>();
  for (const [name, arr] of scalars) {
    if (arr.length !== nPoints) {
      throw new Error(`scalar ${name} has ${arr.length} samples, expected ${nPoints}`);
    }
  }
  const metadata: TraceMetadata = {
    method: "rk45_dopri",
    atol: args.atol,
    rtol: args.rtol,
    maxLocalError: args.maxLocalError,
    reason: args.reason,
    nSteps: nPoints - 1,
  };
  return {
    points,
    nPoints,
    fieldName: args.fieldName,
    seedPoint: args.seedPoint,
    normalization: args.normalization,
    step: args.step ?? null,
    time: args.time ?? null,
    direction: args.direction,
    scalars,
    reason: args.reason,
    metadata,
  };
}

// --- internals (mirror pypic._tracing helpers) ---

/** Unit field direction at a point scaled by `sign`, or null on a domain exit / field null. */
function makeRhs(interp: VectorFieldInterpolator, sign: number, nullThreshold: number): Rhs {
  const field = new Float64Array(3);
  const dir = new Float64Array(3); // reused: dormandPrinceStep copies each RHS into its stage buffer
  return (y: Float64Array): Float64Array | null => {
    if (!interp.sample(y, field)) return null;
    const bx = field[0] ?? 0;
    const by = field[1] ?? 0;
    const bz = field[2] ?? 0;
    const mag = Math.hypot(bx, by, bz);
    if (mag < nullThreshold) return null;
    const s = sign / mag;
    dir[0] = bx * s;
    dir[1] = by * s;
    dir[2] = bz * s;
    return dir;
  };
}

/** Re-sample a failed point to split a domain exit from a field null (mirrors `_classify_failure`). */
function classifyFailure(interp: VectorFieldInterpolator, point: Float64Array): TerminationReason {
  const field = new Float64Array(3);
  return interp.sample(point, field) ? "null_point" : "domain_exit";
}

/** First index in `arr[0:len)` whose value exceeds `value` (numpy `searchsorted(side="right")`). */
function searchSortedRight(arr: Float64Array, len: number, value: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] ?? 0) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SingleDirResult {
  readonly points: Float64Array; // flat (n+1, 3)
  readonly reason: TerminationReason;
  readonly maxLocalError: number;
}

function traceSingleDirectionAdaptive(
  interp: VectorFieldInterpolator,
  seed: Float64Array,
  sign: number,
  atol: number,
  rtol: number,
  stepSizeInit: number,
  minStep: number,
  maxStep: number,
  maxSteps: number,
  nullThreshold: number,
  terminate: ((point: Float64Array) => boolean) | null,
  loopTol: number | null,
  loopMinArclen: number,
  signal?: AbortSignal,
): SingleDirResult {
  const buf = new Float64Array((maxSteps + 1) * 3);
  buf[0] = seed[0] ?? 0;
  buf[1] = seed[1] ?? 0;
  buf[2] = seed[2] ?? 0;
  let n = 0;
  let reason: TerminationReason = "max_steps";
  let h = stepSizeInit;
  let maxLocalError = 0;
  let kCarry: Float64Array | null = null; // FSAL carry; survives a rejection (y unchanged)
  const arclen = loopTol !== null ? new Float64Array(maxSteps + 1) : null;
  const rhs = makeRhs(interp, sign, nullThreshold);
  const control: StepControl = { minStep, maxStep };

  while (n < maxSteps) {
    // Cancellation hook (checked every iteration, accepted or rejected, so a reject-storm can't stall
    // it). Unwinds before makeFieldLine, so an abort never yields a malformed <2-point line. On the
    // main thread today this fires only for an already-aborted signal; true mid-flight preemption
    // arrives once the tracer runs off-main (worker), where this is the durable hook.
    signal?.throwIfAborted();
    const cur = buf.subarray(3 * n, 3 * n + 3); // alias — dormandPrinceStep never mutates y
    const result = dormandPrinceStep(rhs, cur, h, kCarry);
    if (!result.ok) {
      reason = classifyFailure(interp, result.failedPoint);
      break;
    }

    const errNorm = embeddedErrorNorm(result.errVec, result.yNew, atol, rtol);
    if (errNorm > maxLocalError) maxLocalError = errNorm;
    const hNew = iStepController(h, errNorm, control);

    if (errNorm <= 1 || h <= minStep) {
      n += 1;
      const nx = result.yNew[0] ?? 0;
      const ny = result.yNew[1] ?? 0;
      const nz = result.yNew[2] ?? 0;
      buf[3 * n] = nx;
      buf[3 * n + 1] = ny;
      buf[3 * n + 2] = nz;
      kCarry = result.kLast;
      h = hNew;

      if (arclen !== null && loopTol !== null) {
        const px = buf[3 * (n - 1)] ?? 0;
        const py = buf[3 * (n - 1) + 1] ?? 0;
        const pz = buf[3 * (n - 1) + 2] ?? 0;
        arclen[n] = (arclen[n - 1] ?? 0) + Math.hypot(nx - px, ny - py, nz - pz);
        const cutoff = (arclen[n] ?? 0) - loopMinArclen;
        const jEnd = searchSortedRight(arclen, n, cutoff);
        if (jEnd > 0) {
          let minDist = Number.POSITIVE_INFINITY;
          for (let j = 0; j < jEnd; j++) {
            const d = Math.hypot(
              (buf[3 * j] ?? 0) - nx,
              (buf[3 * j + 1] ?? 0) - ny,
              (buf[3 * j + 2] ?? 0) - nz,
            );
            if (d < minDist) minDist = d;
          }
          if (minDist <= loopTol) {
            reason = "closed_loop";
            break;
          }
        }
      }

      if (terminate?.(result.yNew)) {
        reason = "callback";
        break;
      }
    } else {
      h = hNew; // reject: retry with smaller h, y and kCarry unchanged
    }
  }

  return { points: buf.slice(0, 3 * (n + 1)), reason, maxLocalError };
}

function reversePoints(flat: Float64Array): Float64Array {
  const n = flat.length / 3;
  const out = new Float64Array(flat.length);
  for (let i = 0; i < n; i++) {
    const src = (n - 1 - i) * 3;
    const dst = i * 3;
    out[dst] = flat[src] ?? 0;
    out[dst + 1] = flat[src + 1] ?? 0;
    out[dst + 2] = flat[src + 2] ?? 0;
  }
  return out;
}

/** Stitch the two directions: forward as-is, backward reversed, "both" = reversed-backward[:-1] ++ forward. */
export function stitch(
  direction: TraceDirection,
  fwd: SingleDirResult,
  bwd: SingleDirResult,
): { points: Float64Array; reason: TerminationReason; maxLocalError: number } {
  switch (direction) {
    case "forward":
      return { points: fwd.points, reason: fwd.reason, maxLocalError: fwd.maxLocalError };
    case "backward": {
      const points = reversePoints(bwd.points);
      return { points, reason: bwd.reason, maxLocalError: bwd.maxLocalError };
    }
    case "both": {
      const bwdRev = reversePoints(bwd.points);
      const nBwdRev = bwdRev.length / 3;
      const nFwd = fwd.points.length / 3;
      let points: Float64Array;
      if (nBwdRev > 0 && nFwd > 0) {
        points = new Float64Array((nBwdRev - 1) * 3 + fwd.points.length);
        points.set(bwdRev.subarray(0, (nBwdRev - 1) * 3), 0);
        points.set(fwd.points, (nBwdRev - 1) * 3);
      } else if (nBwdRev > 0) {
        points = bwdRev;
      } else {
        points = fwd.points;
      }
      const isMax = fwd.reason === "max_steps" || bwd.reason === "max_steps";
      return {
        points,
        reason: isMax ? "max_steps" : fwd.reason,
        maxLocalError: Math.max(fwd.maxLocalError, bwd.maxLocalError),
      };
    }
  }
}

function resolveLoopKwargs(
  loopTol: number | null,
  loopMinArclen: number | null,
  stepSizeInit: number,
): { loopTol: number | null; loopMinArclen: number } {
  if (loopTol === null) {
    if (loopMinArclen !== null) throw new Error("loopMinArclen requires loopTol to be set");
    return { loopTol: null, loopMinArclen: 0 };
  }
  if (loopTol <= 0) throw new Error(`loopTol must be positive, got ${loopTol}`);
  if (loopMinArclen === null) return { loopTol, loopMinArclen: 10 * stepSizeInit };
  if (loopMinArclen <= 0) throw new Error(`loopMinArclen must be positive, got ${loopMinArclen}`);
  return { loopTol, loopMinArclen };
}

function fieldNameFromComponents(components: readonly [string, string, string]): string {
  const stripped = new Set(components.map((c) => c.replace(/_?\d+$/, "")));
  if (stripped.size !== 1) {
    throw new Error(`components must belong to one field, got ${components.join(", ")}`);
  }
  const [name] = stripped;
  return name ?? "";
}

function toSeed(seed: SeedPoint | Float64Array | readonly number[]): Float64Array {
  return new Float64Array([seed[0] ?? Number.NaN, seed[1] ?? Number.NaN, seed[2] ?? Number.NaN]);
}

export function validateSeed(
  interp: VectorFieldInterpolator,
  seed: Float64Array,
  nullThreshold: number,
): void {
  const field = new Float64Array(3);
  const at = `(${seed[0]}, ${seed[1]}, ${seed[2]})`;
  if (!interp.sample(seed, field)) {
    throw new Error(`seed ${at} is outside the interpolation domain`);
  }
  const mag = Math.hypot(field[0] ?? 0, field[1] ?? 0, field[2] ?? 0);
  if (mag < nullThreshold)
    throw new Error(`seed ${at} is at a field null (|B| < ${nullThreshold})`);
}

/**
 * Resolved numeric/string trace parameters — the single source of pypic-default values shared by the
 * CPU tracer and the WebGPU orchestrator so the two can never drift. `loopTol="auto"` resolves to
 * `0.5·min(spacing)`; `loopMinArclen` defaults to `10·stepSizeInit` (see `resolveLoopKwargs`).
 */
export interface ResolvedTraceParams {
  readonly atol: number;
  readonly rtol: number;
  readonly stepSizeInit: number;
  readonly minStep: number;
  readonly maxStep: number;
  readonly maxSteps: number;
  readonly direction: TraceDirection;
  readonly components: readonly [string, string, string];
  readonly fieldName: string;
  readonly nullThreshold: number;
  readonly loopTol: number | null;
  readonly loopMinArclen: number;
}

/** Resolve `AdaptiveTraceOptions` against pypic's defaults. Pure — no interpolator, no seed, no device. */
export function resolveTraceParams(
  data: FieldDataset,
  options: AdaptiveTraceOptions = {},
): ResolvedTraceParams {
  const stepSizeInit = options.stepSizeInit ?? 0.5;
  const loopTolOpt = options.loopTol ?? "auto";
  const loopTolRaw = loopTolOpt === "auto" ? 0.5 * Math.min(...data.grid.spacing) : loopTolOpt;
  const { loopTol, loopMinArclen } = resolveLoopKwargs(
    loopTolRaw,
    options.loopMinArclen ?? null,
    stepSizeInit,
  );
  const components = options.fieldComponents ?? DEFAULT_COMPONENTS;
  return {
    atol: options.atol ?? 1e-6,
    rtol: options.rtol ?? 1e-3,
    stepSizeInit,
    minStep: options.minStep ?? 1e-8,
    maxStep: options.maxStep ?? 2.0,
    maxSteps: options.maxSteps ?? 10_000,
    direction: options.direction ?? "both",
    components,
    fieldName: fieldNameFromComponents(components),
    nullThreshold: options.nullThreshold ?? 1e-12,
    loopTol,
    loopMinArclen,
  };
}

/**
 * Trace one field line through `data` from `seed` with adaptive Dormand-Prince 5(4). Options mirror
 * pypic's `trace_field_line_adaptive` defaults. Throws if the seed is outside the domain or at a null.
 */
export function traceFieldLineAdaptive(
  data: FieldDataset,
  seed: SeedPoint | Float64Array | readonly number[],
  options: AdaptiveTraceOptions = {},
  signal?: AbortSignal,
): FieldLine {
  signal?.throwIfAborted();
  const p = resolveTraceParams(data, options);
  const terminate = options.terminate ?? null;
  const interp = options.interpolator ?? interpolatorFromDataset(data, p.components);
  const seedArr = toSeed(seed);
  validateSeed(interp, seedArr, p.nullThreshold);
  const seedPoint: SeedPoint = [seedArr[0] ?? 0, seedArr[1] ?? 0, seedArr[2] ?? 0];

  const adapt = (sign: number): SingleDirResult =>
    traceSingleDirectionAdaptive(
      interp,
      seedArr,
      sign,
      p.atol,
      p.rtol,
      p.stepSizeInit,
      p.minStep,
      p.maxStep,
      p.maxSteps,
      p.nullThreshold,
      terminate,
      p.loopTol,
      p.loopMinArclen,
      signal,
    );

  const empty: SingleDirResult = {
    points: new Float64Array(0),
    reason: "max_steps",
    maxLocalError: 0,
  };
  const fwd = p.direction === "forward" || p.direction === "both" ? adapt(1) : empty;
  const bwd = p.direction === "backward" || p.direction === "both" ? adapt(-1) : empty;

  const stitched = stitch(p.direction, fwd, bwd);
  return makeFieldLine({
    points: stitched.points,
    fieldName: p.fieldName,
    seedPoint,
    normalization: data.normalization,
    direction: p.direction,
    reason: stitched.reason,
    atol: p.atol,
    rtol: p.rtol,
    maxLocalError: stitched.maxLocalError,
    step: data.step,
  });
}

export function toSeedList(
  seeds: ReadonlyArray<SeedPoint | readonly number[]> | Float64Array,
): Float64Array[] {
  if (seeds instanceof Float64Array) {
    const out: Float64Array[] = [];
    for (let i = 0; i + 3 <= seeds.length; i += 3) out.push(seeds.slice(i, i + 3));
    return out;
  }
  return seeds.map((s) => toSeed(s));
}

/**
 * Trace N field lines from `seeds` (an array of (x,y,z) triples or a flat Float64Array). Builds the
 * interpolator once and validates every seed up front (mirrors pypic), so an invalid seed throws before
 * any tracing. The vectorized DP kernel stays on the GPU (M4.3); this loops the single-seed tracer.
 */
export function traceFieldLinesAdaptive(
  data: FieldDataset,
  seeds: ReadonlyArray<SeedPoint | readonly number[]> | Float64Array,
  options: AdaptiveTraceOptions = {},
  signal?: AbortSignal,
): FieldLine[] {
  signal?.throwIfAborted();
  const components = options.fieldComponents ?? DEFAULT_COMPONENTS;
  const interp = options.interpolator ?? interpolatorFromDataset(data, components);
  const nullThreshold = options.nullThreshold ?? 1e-12;
  const seedList = toSeedList(seeds);
  for (const s of seedList) validateSeed(interp, s, nullThreshold);
  // Each per-seed trace re-checks `signal` at entry + per integration step, so a cancel lands between
  // seeds and mid-line.
  return seedList.map((s) =>
    traceFieldLineAdaptive(data, s, { ...options, interpolator: interp }, signal),
  );
}
