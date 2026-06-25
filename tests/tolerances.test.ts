import { describe, expect, it } from "vitest";
import { KERNELS, PRECISIONS, type Precision, TOL } from "./tolerances.ts";

// Structural guards on the tolerance matrix: it must stay complete, and its precision rows must form
// an honest ladder — f64 the tightest reference, f16 the loosest derived bound, and the cancelling
// FD operators never tighter than magnitude. These catch a cell silently tightened below a measured
// floor, or a kernel/precision dropped from the matrix. (No ts_f32-vs-webgpu_f32 ordering: same
// precision class, no inherent order.)

const NON_F64: readonly Precision[] = PRECISIONS.filter((p) => p !== "ts_f64");
const NON_F16: readonly Precision[] = PRECISIONS.filter((p) => p !== "webgpu_f16");
const FD_KERNELS = ["divergence", "curl", "gradient"] as const;

describe("tolerance matrix", () => {
  it("is complete with finite, positive bounds", () => {
    for (const kernel of KERNELS) {
      for (const precision of PRECISIONS) {
        const cell = TOL[kernel][precision];
        expect(Number.isFinite(cell.rtol), `${kernel}.${precision}.rtol`).toBe(true);
        expect(Number.isFinite(cell.atol), `${kernel}.${precision}.atol`).toBe(true);
        expect(cell.rtol, `${kernel}.${precision}.rtol`).toBeGreaterThan(0);
        expect(cell.atol, `${kernel}.${precision}.atol`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps ts_f64 the tightest row per kernel (the f64 reference floor)", () => {
    for (const kernel of KERNELS) {
      const ref = TOL[kernel].ts_f64;
      for (const precision of NON_F64) {
        const cell = TOL[kernel][precision];
        expect(cell.rtol, `${kernel}.${precision}.rtol ≥ ts_f64`).toBeGreaterThanOrEqual(ref.rtol);
        expect(cell.atol, `${kernel}.${precision}.atol ≥ ts_f64`).toBeGreaterThanOrEqual(ref.atol);
      }
    }
  });

  it("keeps webgpu_f16 the loosest row per kernel (derived half-precision bound)", () => {
    for (const kernel of KERNELS) {
      const f16 = TOL[kernel].webgpu_f16;
      for (const precision of NON_F16) {
        const cell = TOL[kernel][precision];
        expect(f16.rtol, `webgpu_f16 ≥ ${kernel}.${precision}.rtol`).toBeGreaterThanOrEqual(
          cell.rtol,
        );
        expect(f16.atol, `webgpu_f16 ≥ ${kernel}.${precision}.atol`).toBeGreaterThanOrEqual(
          cell.atol,
        );
      }
    }
  });

  it("never makes magnitude looser than the cancelling FD operators", () => {
    for (const precision of PRECISIONS) {
      const mag = TOL.magnitude[precision];
      for (const kernel of FD_KERNELS) {
        const cell = TOL[kernel][precision];
        expect(mag.rtol, `magnitude ≤ ${kernel}.${precision}.rtol`).toBeLessThanOrEqual(cell.rtol);
        expect(mag.atol, `magnitude ≤ ${kernel}.${precision}.atol`).toBeLessThanOrEqual(cell.atol);
      }
    }
  });
});
