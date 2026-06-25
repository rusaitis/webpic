// Per-precision tolerance presets for the numeric-kernel assertions (assertAllclose).
// One row per compute precision so a test states the path it exercises instead of hard-coding
// magic rtol/atol: `ts_f64` is the TS reference path, `ts_f32` the render-precision downcast,
// `webgpu_f32` the WebGPU compute backend (f32 storage + arithmetic), and `webgpu_f16` a placeholder
// for a future half-precision path. Mirrors pypic's per-kernel, per-precision tolerance philosophy;
// widen a row only with a measured reason.

export interface Tolerance {
  readonly rtol: number;
  readonly atol: number;
}

export const TOL = {
  ts_f64: { rtol: 1e-12, atol: 1e-12 },
  ts_f32: { rtol: 1e-6, atol: 1e-6 },
  // GPU f32 vs the f64 TS twin: the gap is f32 arithmetic ordering, not algorithm — bounded by ~1e-5
  // relative with an absolute floor for the zero-crossings of curl/divergence. M3.2 may split this
  // per-kernel once goldens land; widen only with a measured reason.
  webgpu_f32: { rtol: 1e-5, atol: 1e-6 },
  webgpu_f16: { rtol: 1e-2, atol: 1e-2 }, // placeholder — no half-precision kernel yet
} as const satisfies Record<string, Tolerance>;
