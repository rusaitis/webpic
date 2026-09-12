// Per-kernel, per-precision tolerances for the numeric-kernel assertions (assertAllclose).
// Outer key = the operator under test; inner key = the precision path that produced `actual`.
//
// Precision rows:
//   ts_f64     — the TS reference path (coordinates/ + derived/), f64 arithmetic. The yardstick.
//   ts_f32     — the same algorithm at render precision (f32 in, f32 out).
//   webgpu_f32 — the WebGPU compute backend (f32 storage + arithmetic).
//   webgpu_f16 — a half-precision compute path. NOT IMPLEMENTED: `shader-f16` isn't even
//                requested (gpu/capabilities.ts) and f16 lives only in the render transfer-function
//                texture. These cells are paper bounds from the f16 unit roundoff (2^-11 ≈ 4.9e-4),
//                kept so the matrix is ready the day an f16 kernel lands — they are not measurements.
//
// The assertion always compares a kernel against a SAME-ALGORITHM reference (the TS twin, or a pypic
// np.gradient golden), so finite-difference TRUNCATION cancels and only the
// arithmetic-PRECISION gap remains. That gap is kernel-specific: |X| is one fused sum-of-squares +
// sqrt (no cancellation → tight), whereas curl/divergence/gradient subtract nearly-equal neighbors
// (catastrophic cancellation near zero-crossings → a larger atol floor at the same precision).
//
// MEASURED, and by which suite: magnitude/curl/divergence @ webgpu_f32 (parity.browser, small smooth
// grid); magnitude @ ts_f32 (magnitude.test); trace @ webgpu_f32 (streamlines.browser); every kernel
// @ ts_f64 (analytical-exact linear fields — trilinear and a straight-line trace included). Every
// other cell is a DERIVED estimate, to be re-pinned with a measured reason once a suite produces
// one. Widen a cell only with a measured reason; never silently tighten. (The pypic goldens may
// widen curl/div ts_f64 toward ~1e-10, and webgpu_f32's atol floor at 256³ on turbulent data —
// DESIGN §Testing — but only once that measurement exists.)

export interface Tolerance {
  readonly rtol: number;
  readonly atol: number;
}

// The f64 reference floor: machine roundoff for a same-algorithm f64 comparison. Backs every
// `ts_f64` cell and is the assertAllclose default.
export const DEFAULT_TOLERANCE: Tolerance = { rtol: 1e-12, atol: 1e-12 };

export const KERNELS = ["magnitude", "divergence", "curl", "gradient", "interp", "trace"] as const;
export const PRECISIONS = ["ts_f64", "ts_f32", "webgpu_f32", "webgpu_f16"] as const;
export type Kernel = (typeof KERNELS)[number];
export type Precision = (typeof PRECISIONS)[number];

export const TOL = {
  // |X| = sqrt(X1²+X2²+X3²): one sum-of-squares + sqrt, no cancellation → the tightest kernel.
  magnitude: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-6, atol: 1e-6 }, // measured (magnitude.test)
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // measured (parity.browser)
    webgpu_f16: { rtol: 1e-3, atol: 1e-3 }, // derived — no f16 kernel
  },
  // np.gradient central/one-sided differences. f32 cancellation near zero-crossings → looser floor.
  divergence: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-5, atol: 1e-5 }, // derived — no TS f32 FD path exercised yet
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // measured (small smooth grid)
    webgpu_f16: { rtol: 5e-3, atol: 5e-3 }, // derived
  },
  curl: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-5, atol: 1e-5 }, // derived
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // measured (small smooth grid)
    webgpu_f16: { rtol: 5e-3, atol: 5e-3 }, // derived
  },
  // Same FD numerics as curl/divergence; no WGSL gradient kernel shipped, so its webgpu rows
  // are derived by analogy, not measured.
  gradient: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-5, atol: 1e-5 }, // derived
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // derived — no WGSL gradient kernel
    webgpu_f16: { rtol: 5e-3, atol: 5e-3 }, // derived
  },
  // Trilinear sampling (numerics/interp.ts ↔ the WGSL streamline kernel's manual blend): a convex
  // combination of eight corners — no cancellation, so it tracks magnitude, not the FD operators.
  // Exact on a linear field at f64, which is what the interp suite asserts.
  interp: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-6, atol: 1e-6 }, // derived by analogy with magnitude's measured f32 row
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // derived — the kernel is only exercised through trace
    webgpu_f16: { rtol: 1e-3, atol: 1e-3 }, // derived
  },
  // Field-line traces: positions in GRID units, compared point-wise against the CPU twin or a pypic
  // golden that ran the same DP5(4) stencil, so only arithmetic precision separates them. Integration
  // ACCUMULATES that gap along the curve, hence a looser floor than the single-pass kernels.
  trace: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-5, atol: 1e-5 }, // derived — no f32 CPU tracer
    webgpu_f32: { rtol: 1e-5, atol: 1e-5 }, // measured (streamlines.browser: worst |Δ| ≈ 2.4e-6)
    webgpu_f16: { rtol: 5e-3, atol: 5e-3 }, // derived
  },
} as const satisfies Record<Kernel, Record<Precision, Tolerance>>;

// The conservation identities (div(curl F) ≡ 0, curl(grad f) ≡ 0) compare against exact zero, so a
// relative tolerance is meaningless — the bound is purely absolute. Roundoff enters through the
// second derivative, so it scales with the worst inverse-spacing-squared on the grid (pypic's
// bound). Not a KERNELS row: this is a property of the identity, not of a precision class.
const CONSERVATION_ROUNDOFF = 2e-13;

export function conservationTolerance(spacing: readonly number[]): Tolerance {
  return { rtol: 0, atol: CONSERVATION_ROUNDOFF / Math.min(...spacing) ** 2 };
}
