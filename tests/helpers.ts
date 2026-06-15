import { expect } from "vitest";

// Drain the microtask queue (via a macrotask tick) so a fire-and-forget async store action settles
// before assertions — the recompute that setDataset/selectField kick off computes the active field
// through the async dispatcher (compute/field.ts). The TS backend resolves on the next microtask, so
// one macrotask hop is always enough; it's the test-side mirror of "subscribers react when it lands".
export const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Shared array-wise tolerance assertion for the numeric kernels. Pre-stages the
// per-precision tolerance tables planned for tests/tolerances.ts.
export function assertAllclose(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  { rtol = 1e-12, atol = 0 }: { rtol?: number; atol?: number } = {},
): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i] ?? Number.NaN;
    const e = expected[i] ?? Number.NaN;
    expect(Math.abs(a - e)).toBeLessThanOrEqual(atol + rtol * Math.abs(e));
  }
}
