import type { LogSink } from "@schema/log.ts";
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
  // One expect for the whole array, scanning for the worst violation: a per-element expect costs
  // minutes on the 256³ parity arrays, and the reported index says more than "some element differs".
  let worst = -1;
  let worstExcess = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i] ?? Number.NaN;
    const e = expected[i] ?? Number.NaN;
    const excess = Math.abs(a - e) - (atol + rtol * Math.abs(e));
    if (!(excess <= 0) && (worst < 0 || excess > worstExcess)) {
      worst = i;
      worstExcess = excess;
    }
  }
  const detail =
    worst < 0
      ? ""
      : `assertAllclose: worst at [${worst}] — actual ${actual[worst]}, expected ${expected[worst]}, over rtol ${rtol} / atol ${atol} by ${worstExcess}`;
  expect(detail).toBe("");
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

export interface CapturedLog {
  readonly level: "warn" | "error";
  readonly scope: string;
  readonly message: string;
  readonly detail: unknown;
}

// A @schema/log sink that records instead of writing, so a test can assert a diagnostic actually
// reached the log seam. Install with `setLogSink(recordingSink(captured))` and clear it in afterEach.
export function recordingSink(into: CapturedLog[]): LogSink {
  return {
    warn: (scope, message, detail) => into.push({ level: "warn", scope, message, detail }),
    error: (scope, message, detail) => into.push({ level: "error", scope, message, detail }),
  };
}
