// Per-precision tolerance presets for the numeric-kernel assertions (assertAllclose).
// One row per compute precision so a test states the path it exercises instead of hard-coding
// magic rtol/atol: `ts_f64` is the TS reference path, `ts_f32` the render-precision downcast, and
// `webgpu_f16` a placeholder until the WebGPU backend lands (M3). Mirrors pypic's per-kernel,
// per-precision tolerance philosophy; widen a row only with a measured reason.

export interface Tolerance {
  readonly rtol: number;
  readonly atol: number;
}

export const TOL = {
  ts_f64: { rtol: 1e-12, atol: 1e-12 },
  ts_f32: { rtol: 1e-6, atol: 1e-6 },
  webgpu_f16: { rtol: 1e-2, atol: 1e-2 }, // placeholder — set from real cross-backend runs at M3
} as const satisfies Record<string, Tolerance>;
