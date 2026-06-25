import { describe, expect, it } from "vitest";
import {
  type DPStepResult,
  dormandPrinceStep,
  embeddedErrorNorm,
  iStepController,
  type Rhs,
} from "./integrators.ts";

// Inline tolerances throughout: the integrator's accuracy is a method property (truncation order),
// not a backend-precision gap, so it stays out of tests/tolerances.ts (whose matrix is the FD
// kernels). The doctest cases pin bit-fidelity against pypic; the convergence ratio confirms order.

function expectOk(r: DPStepResult): Extract<DPStepResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected an accepted step, got failure at stage ${r.failedStage}`);
  return r;
}

function assertExactArray(actual: Float64Array, expected: Float64Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(actual[i]).toBe(expected[i]);
}

// y' = -y, scalar — analytic solution e^{-t}.
const decay: Rhs = (y) => new Float64Array([-(y[0] ?? Number.NaN)]);

describe("embeddedErrorNorm", () => {
  it("matches the pypic RMS doctest", () => {
    const norm = embeddedErrorNorm(
      new Float64Array([1e-6, 2e-6]),
      new Float64Array([1, 2]),
      1e-6,
      0,
    );
    expect(norm).toBeCloseTo(1.581139, 6);
  });

  it("collapses to |err| / scale for a single component", () => {
    expect(embeddedErrorNorm(new Float64Array([3e-6]), new Float64Array([1]), 1e-6, 0)).toBeCloseTo(
      3,
      12,
    );
  });
});

describe("iStepController", () => {
  it("returns the safety factor when err sits at tolerance (pypic doctest)", () => {
    expect(iStepController(1, 1, { minStep: 1e-6, maxStep: 10 })).toBeCloseTo(0.9, 12);
  });

  it("clamps growth to GROWTH_MAX as err → 0 (pypic doctest)", () => {
    expect(iStepController(1, 0, { minStep: 1e-6, maxStep: 10 })).toBe(5);
  });

  it("clamps the shrink ratio to GROWTH_MIN for a large error", () => {
    expect(iStepController(1, 1e6, { minStep: 1e-9, maxStep: 10 })).toBeCloseTo(0.2, 12);
  });

  it("honors the absolute max-step clamp", () => {
    expect(iStepController(10, 0, { minStep: 1e-6, maxStep: 12 })).toBe(12); // 10·5 = 50 → 12
  });

  it("honors the absolute min-step clamp", () => {
    expect(iStepController(1e-3, 1e6, { minStep: 1e-3, maxStep: 10 })).toBeCloseTo(1e-3, 12);
  });
});

describe("dormandPrinceStep", () => {
  it("matches e^{-h} for y' = -y over one step", () => {
    const r = expectOk(dormandPrinceStep(decay, new Float64Array([1]), 0.1));
    expect(Math.abs((r.yNew[0] ?? Number.NaN) - Math.exp(-0.1))).toBeLessThan(1e-9);
  });

  it("integrates a constant RHS exactly (linear solution, Σb = 1)", () => {
    const r = expectOk(dormandPrinceStep(() => new Float64Array([2]), new Float64Array([0]), 0.5));
    expect(r.yNew[0] ?? Number.NaN).toBeCloseTo(1, 12); // y' = 2 → y(0.5) = 1
    expect(r.errVec[0] ?? Number.NaN).toBeCloseTo(0, 12); // ΣE = 0
  });

  it("integrates backward for negative h", () => {
    const r = expectOk(dormandPrinceStep(decay, new Float64Array([1]), -0.1));
    expect(Math.abs((r.yNew[0] ?? Number.NaN) - Math.exp(0.1))).toBeLessThan(1e-9);
  });

  it("re-uses the FSAL carry exactly (k0 = previous kLast ≡ fresh f(yNew))", () => {
    const a = expectOk(dormandPrinceStep(decay, new Float64Array([1]), 0.1));
    // The FSAL row is evaluated at the new solution, so kLast == f(yNew) to the bit.
    const fAtNew = decay(a.yNew);
    expect(fAtNew).not.toBeNull();
    assertExactArray(a.kLast, fAtNew as Float64Array);
    // Stepping on with the carry equals stepping fresh (which recomputes f(yNew)).
    const withCarry = expectOk(dormandPrinceStep(decay, a.yNew, 0.1, a.kLast));
    const fresh = expectOk(dormandPrinceStep(decay, a.yNew, 0.1));
    assertExactArray(withCarry.yNew, fresh.yNew);
    assertExactArray(withCarry.errVec, fresh.errVec);
  });

  it("keeps harmonic-oscillator energy bounded over many steps", () => {
    // y = [x, v]; x' = v, v' = -x → energy x² + v² conserved analytically.
    const osc: Rhs = (y) => new Float64Array([y[1] ?? Number.NaN, -(y[0] ?? Number.NaN)]);
    let y: Float64Array = new Float64Array([1, 0]); // E₀ = 1
    let carry: Float64Array | null = null;
    for (let step = 0; step < 1000; step++) {
      const r = expectOk(dormandPrinceStep(osc, y, 0.05, carry));
      y = r.yNew;
      carry = r.kLast;
    }
    const energy = (y[0] ?? Number.NaN) ** 2 + (y[1] ?? Number.NaN) ** 2;
    expect(Math.abs(energy - 1)).toBeLessThan(1e-6);
  });
});

describe("dormandPrinceStep convergence", () => {
  // Fixed-h march of y' = -y over [0, T]; global error vs the analytic e^{-T}.
  function marchDecayError(steps: number): number {
    const finalTime = 2;
    const h = finalTime / steps;
    let y: Float64Array = new Float64Array([1]);
    let carry: Float64Array | null = null;
    for (let step = 0; step < steps; step++) {
      const r = expectOk(dormandPrinceStep(decay, y, h, carry));
      y = r.yNew;
      carry = r.kLast;
    }
    return Math.abs((y[0] ?? Number.NaN) - Math.exp(-finalTime));
  }

  it("converges at 5th order (global error ∝ h⁵)", () => {
    const errCoarse = marchDecayError(8);
    const errFine = marchDecayError(16);
    expect(errCoarse).toBeGreaterThan(0);
    expect(errFine).toBeGreaterThan(0);
    // Halving h cuts a 5th-order global error ~2⁵ = 32×; ≥ 24 rules out 4th order (16×).
    expect(errCoarse / errFine).toBeGreaterThanOrEqual(24);
  });
});

describe("dormandPrinceStep failure", () => {
  it("reports a stage-0 failure when the RHS is invalid at the seed", () => {
    const r = dormandPrinceStep(() => null, new Float64Array([3, 4]), 0.1);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failedStage).toBe(0);
    assertExactArray(r.failedPoint, new Float64Array([3, 4]));
  });

  it("reports the failing stage and point when the RHS goes invalid mid-step", () => {
    // Valid at the seed; invalid once a stage walks y[0] above 1. Stage 1 steps by h·a₁₀·10 = 0.2.
    const f: Rhs = (y) => ((y[0] ?? Number.NaN) > 1 ? null : new Float64Array([10]));
    const r = dormandPrinceStep(f, new Float64Array([0.999]), 0.1);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failedStage).toBe(1);
    expect(r.failedPoint[0] ?? Number.NaN).toBeCloseTo(1.199, 12);
  });
});
