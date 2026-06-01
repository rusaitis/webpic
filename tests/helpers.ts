import { expect } from "vitest";

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
