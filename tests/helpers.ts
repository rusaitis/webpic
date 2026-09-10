import { expect } from "vitest";
import { DEFAULT_TOLERANCE, type Tolerance } from "./tolerances.ts";

// Drain the microtask queue (via a macrotask tick) so a fire-and-forget async store action settles
// before assertions — the recompute that setDataset/selectField kick off computes the active field
// through the async dispatcher (compute/field.ts). The TS backend resolves on the next microtask, so
// one macrotask hop is always enough; it's the test-side mirror of "subscribers react when it lands".
export const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Shared array-wise tolerance assertion for the numeric kernels. Defaults to the f64 reference
// floor; pass a tests/tolerances.ts cell (TOL.magnitude.ts_f32, …) or a partial override otherwise.
export function assertAllclose(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  tol: Partial<Tolerance> = DEFAULT_TOLERANCE,
): void {
  const rtol = tol.rtol ?? DEFAULT_TOLERANCE.rtol;
  const atol = tol.atol ?? DEFAULT_TOLERANCE.atol;
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i] ?? Number.NaN;
    const e = expected[i] ?? Number.NaN;
    expect(Math.abs(a - e)).toBeLessThanOrEqual(atol + rtol * Math.abs(e));
  }
}

// Park–Miller minimal-standard LCG in (0, 1). Deterministic (no Math.random) so the bit-level
// tolerances the fuzz and conservation suites assert can't flake on a bad draw.
export function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}
