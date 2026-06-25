// Per-kernel, per-precision tolerances for the numeric-kernel assertions (assertAllclose).
// Outer key = the operator under test; inner key = the precision path that produced `actual`.
//
// Precision rows:
//   ts_f64     — the TS reference path (coordinates/ + derived/), f64 arithmetic. The yardstick.
//   ts_f32     — the same algorithm at render precision (f32 in, f32 out).
//   webgpu_f32 — the WebGPU compute backend (f32 storage + arithmetic).
//   webgpu_f16 — a half-precision compute path. NOT IMPLEMENTED in v0.1: `shader-f16` isn't even
//                requested (gpu/capabilities.ts) and f16 lives only in the render transfer-function
//                texture. These cells are paper bounds from the f16 unit roundoff (2^-11 ≈ 4.9e-4),
//                kept so the matrix is ready the day an f16 kernel lands — they are not measurements.
//
// The assertion always compares a kernel against a SAME-ALGORITHM reference (the TS twin, or — from
// M3.4 — a pypic np.gradient golden), so finite-difference TRUNCATION cancels and only the
// arithmetic-PRECISION gap remains. That gap is kernel-specific: |X| is one fused sum-of-squares +
// sqrt (no cancellation → tight), whereas curl/divergence/gradient subtract nearly-equal neighbors
// (catastrophic cancellation near zero-crossings → a larger atol floor at the same precision).
//
// MEASURED today: magnitude/curl/divergence @ webgpu_f32 (M3.1 parity.browser, small smooth grid);
// magnitude @ ts_f32 (magnitude.test); all four @ ts_f64 (analytical-exact linear fields). Every
// other cell is a DERIVED estimate, re-pinned with a measured reason as M3.3 (ts-vs-webgpu harness)
// and M3.4 (pypic goldens) land. Widen a cell only with a measured reason; never silently tighten.
// (M3.4 may widen curl/div ts_f64 toward ~1e-10 and webgpu_f32's atol floor at 256³ on turbulent
// data — DESIGN §Testing — but only once that measurement exists.)

export interface Tolerance {
  readonly rtol: number;
  readonly atol: number;
}

// The f64 reference floor: machine roundoff for a same-algorithm f64 comparison. Backs every
// `ts_f64` cell and is the assertAllclose default.
export const DEFAULT_TOLERANCE: Tolerance = { rtol: 1e-12, atol: 1e-12 };

export const KERNELS = ["magnitude", "divergence", "curl", "gradient"] as const;
export const PRECISIONS = ["ts_f64", "ts_f32", "webgpu_f32", "webgpu_f16"] as const;
export type Kernel = (typeof KERNELS)[number];
export type Precision = (typeof PRECISIONS)[number];

export const TOL = {
  // |X| = sqrt(X1²+X2²+X3²): one sum-of-squares + sqrt, no cancellation → the tightest kernel.
  magnitude: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-6, atol: 1e-6 }, // measured (magnitude.test)
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // measured (M3.1 parity.browser)
    webgpu_f16: { rtol: 1e-3, atol: 1e-3 }, // derived — no f16 kernel
  },
  // np.gradient central/one-sided differences. f32 cancellation near zero-crossings → looser floor.
  divergence: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-5, atol: 1e-5 }, // derived — no TS f32 FD path exercised yet
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // measured (M3.1, small smooth grid)
    webgpu_f16: { rtol: 5e-3, atol: 5e-3 }, // derived
  },
  curl: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-5, atol: 1e-5 }, // derived
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // measured (M3.1, small smooth grid)
    webgpu_f16: { rtol: 5e-3, atol: 5e-3 }, // derived
  },
  // Same FD numerics as curl/divergence; M3.1 shipped no WGSL gradient kernel, so its webgpu rows
  // are derived by analogy, not measured.
  gradient: {
    ts_f64: DEFAULT_TOLERANCE,
    ts_f32: { rtol: 1e-5, atol: 1e-5 }, // derived
    webgpu_f32: { rtol: 1e-5, atol: 1e-6 }, // derived — no WGSL gradient kernel
    webgpu_f16: { rtol: 5e-3, atol: 5e-3 }, // derived
  },
} as const satisfies Record<Kernel, Record<Precision, Tolerance>>;
