// Dormand-Prince 5(4) adaptive ODE step — the CPU reference the field-line tracer is built on.
// Seven-stage FSAL Runge-Kutta: the 5th-order weights (DP_B5) propagate the solution, the embedded
// 4th-order weights (DP_B4) give the error estimate that drives step-size control. State-vector-
// agnostic; the RHS may return null to flag an invalid point (magnetic null, out-of-domain) so the
// caller classifies the stop in its own vocabulary. Mirrors pypic.numerics — the tableau is written
// as exact fractions so the f64 rounding matches numpy. Pure leaf, no THREE/DOM/GPU.

/** RHS of the ODE `dy/dt = f(y)`. Returns a same-length vector, or null to signal an invalid point. */
export type Rhs = (y: Float64Array) => Float64Array | null;

/**
 * Outcome of one Dormand-Prince 5(4) step. On success carries the 5th-order solution, the embedded
 * error vector, and the FSAL last-stage value (`f(yNew)`) for re-use as the next step's `k0`. On
 * failure carries the stage index (0–6) whose RHS returned null and the point passed to it.
 */
export type DPStepResult =
  | {
      readonly ok: true;
      readonly yNew: Float64Array;
      readonly errVec: Float64Array;
      readonly kLast: Float64Array;
    }
  | { readonly ok: false; readonly failedStage: number; readonly failedPoint: Float64Array };

// Dormand-Prince 5(4) Butcher tableau (7 stages, FSAL). DP_A rows = stage weights on prior stages.
const DP_A: readonly Float64Array[] = [
  new Float64Array([0, 0, 0, 0, 0, 0, 0]),
  new Float64Array([1 / 5, 0, 0, 0, 0, 0, 0]),
  new Float64Array([3 / 40, 9 / 40, 0, 0, 0, 0, 0]),
  new Float64Array([44 / 45, -56 / 15, 32 / 9, 0, 0, 0, 0]),
  new Float64Array([19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729, 0, 0, 0]),
  new Float64Array([9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656, 0, 0]),
  new Float64Array([35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0]),
];
const DP_B5 = new Float64Array([35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0]);
const DP_B4 = new Float64Array([
  5179 / 57600,
  0,
  7571 / 16695,
  393 / 640,
  -92097 / 339200,
  187 / 2100,
  1 / 40,
]);
// Error weights = 5th- minus 4th-order, formed once at load (matches numpy's `_DP_E = _DP_B5 - _DP_B4`).
const DP_E = DP_B5.map((b5, i) => b5 - (DP_B4[i] ?? 0));

const STAGES = 7;

/**
 * One Dormand-Prince 5(4) step from `y` over a step of size `h` (sign-bearing — pass `h < 0` to
 * integrate backward). Pass the previous accepted step's `kLast` as `k0` to skip the stage-0 RHS
 * evaluation (FSAL). Does not mutate `y`.
 */
export function dormandPrinceStep(
  f: Rhs,
  y: Float64Array,
  h: number,
  k0: Float64Array | null = null,
): DPStepResult {
  const n = y.length;
  const k = new Float64Array(STAGES * n); // stage i occupies [i*n, (i+1)*n)

  if (k0 !== null) {
    k.set(k0, 0);
  } else {
    const rhs0 = f(y);
    if (rhs0 === null) return { ok: false, failedStage: 0, failedPoint: y.slice() };
    k.set(rhs0, 0);
  }

  const yi = new Float64Array(n); // reused stage-input buffer
  for (let i = 1; i < STAGES; i++) {
    const ai = DP_A[i];
    for (let idx = 0; idx < n; idx++) {
      let acc = 0;
      for (let j = 0; j < i; j++) acc += (ai?.[j] ?? 0) * (k[j * n + idx] ?? 0);
      yi[idx] = (y[idx] ?? 0) + h * acc;
    }
    const rhsVal = f(yi);
    if (rhsVal === null) return { ok: false, failedStage: i, failedPoint: yi.slice() };
    k.set(rhsVal, i * n);
  }

  const yNew = new Float64Array(n);
  const errVec = new Float64Array(n);
  for (let idx = 0; idx < n; idx++) {
    let accSolution = 0;
    let accError = 0;
    for (let i = 0; i < STAGES; i++) {
      const ki = k[i * n + idx] ?? 0;
      accSolution += (DP_B5[i] ?? 0) * ki;
      accError += (DP_E[i] ?? 0) * ki;
    }
    yNew[idx] = (y[idx] ?? 0) + h * accSolution;
    errVec[idx] = h * accError;
  }
  return { ok: true, yNew, errVec, kLast: k.slice(6 * n, STAGES * n) };
}

/**
 * RMS norm of `errVec` scaled by the mixed tolerance `atol + rtol·|yNew|`, per component. A value
 * `≤ 1` means the step is acceptable under the requested tolerances (SciPy/Hairer-Nørsett-Wanner
 * convention).
 */
export function embeddedErrorNorm(
  errVec: Float64Array,
  yNew: Float64Array,
  atol: number,
  rtol: number,
): number {
  const n = errVec.length;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const scale = atol + rtol * Math.abs(yNew[i] ?? 0);
    const scaled = (errVec[i] ?? 0) / scale;
    sumSq += scaled * scaled;
  }
  return Math.sqrt(sumSq / n);
}

// I-controller tuning constants (shared across embedded-RK orders).
const SAFETY = 0.9; // bias accepted steps slightly small
const GROWTH_MIN = 0.2; // max shrink ratio per accept/reject
const GROWTH_MAX = 5; // max growth ratio per accept
const ERR_FLOOR = 1e-15; // avoid pow(0, ·) when err is exactly machine zero

export interface StepControl {
  readonly minStep: number;
  readonly maxStep: number;
  /** Order of the embedded method's higher-order solution. Default 5 (Dormand-Prince 5(4)). */
  readonly order?: number;
}

/**
 * Next step size from the current step and its error norm: the elementary (I) controller
 * `h·S·err^(-1/p)` with safety factor `S = 0.9`, growth clamped to `[0.2, 5]` and the result clamped
 * to `[minStep, maxStep]`.
 */
export function iStepController(h: number, errNorm: number, control: StepControl): number {
  const order = control.order ?? 5;
  const raw = SAFETY * Math.max(errNorm, ERR_FLOOR) ** (-1 / order);
  const factor = Math.min(GROWTH_MAX, Math.max(GROWTH_MIN, raw));
  return Math.min(control.maxStep, Math.max(control.minStep, h * factor));
}
