// "Nice" 1-2-5 axis-tick math for the scene overlay grid. Pure, DOM-free, three-free — the spacing
// snaps to {1,2,5}×10ᵏ so a grid over arbitrary physical bounds reads in round numbers (50, 100, …
// not 51.2). Node-testable against fixtures; called once per axis per overlay rebuild, never per frame.

export interface NiceTicks {
  /** The chosen 1/2/5×10ᵏ major step (> 0), or 0 for a degenerate range. */
  readonly step: number;
  /** Ascending major-tick values within [min, max] (inclusive, clipped to the bounds). */
  readonly ticks: readonly number[];
  /** Fractional digits the step needs for label formatting (step 50 → 0, 0.2 → 1). */
  readonly decimals: number;
}

// Runaway guard: a pathological bounds/targetCount can't allocate an unbounded tick list.
const MAX_TICKS = 1000;

/** Snap a positive magnitude to {1,2,5,10}×10ᵏ — up (`round=false`) or to nearest (`round=true`). */
function niceNum(value: number, round: boolean): number {
  if (!(value > 0)) return 0;
  const exp = Math.floor(Math.log10(value));
  const frac = value / 10 ** exp; // ∈ [1, 10)
  const nice = round
    ? frac < 1.5
      ? 1
      : frac < 3
        ? 2
        : frac < 7
          ? 5
          : 10
    : frac <= 1
      ? 1
      : frac <= 2
        ? 2
        : frac <= 5
          ? 5
          : 10;
  return nice * 10 ** exp;
}

/**
 * Major ticks over [min, max] targeting ~`targetCount` divisions, snapped to a 1/2/5 lattice.
 * Inverted ranges are normalized; a zero-width or non-finite range returns a single degenerate tick
 * (`step: 0`) so callers draw nothing rather than dividing by zero.
 */
export function niceTicks(min: number, max: number, targetCount: number): NiceTicks {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!(hi > lo)) return { step: 0, ticks: [lo], decimals: 0 };

  const count = Math.max(1, Math.floor(targetCount));
  const step = niceNum((hi - lo) / count, true);
  if (!(step > 0)) return { step: 0, ticks: [lo], decimals: 0 };

  // Integer-indexed walk (i·step) avoids float drift that `v += step` accumulates over many ticks.
  const startIndex = Math.ceil(lo / step - 1e-9);
  const endIndex = Math.floor(hi / step + 1e-9);
  const ticks: number[] = [];
  for (let i = startIndex; i <= endIndex && ticks.length < MAX_TICKS; i++) {
    const value = i * step;
    ticks.push(value === 0 ? 0 : value); // normalize a -0 (from i=-0) to +0
  }

  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return { step, ticks, decimals };
}
