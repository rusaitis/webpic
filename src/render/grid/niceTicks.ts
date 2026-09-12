// "Nice" 1-2-5 axis-tick math for the scene overlay grid. Pure, DOM-free, three-free — the spacing
// snaps to {1,2,5}×10ᵏ so a grid over arbitrary physical bounds reads in round numbers (50, 100, …
// not 51.2). Node-testable against fixtures; called once per axis per overlay rebuild, never per frame.

export interface NiceTicks {
  // The chosen 1/2/5×10ᵏ major step (> 0), or 0 for a degenerate range.
  readonly step: number;
  // Ascending major-tick values within [min, max] (inclusive, clipped to the bounds).
  readonly ticks: readonly number[];
  // Fractional digits the step needs for label formatting (step 50 → 0, 0.2 → 1).
  readonly decimals: number;
}

// Runaway guard: a pathological bounds/targetCount can't allocate an unbounded tick list.
const MAX_TICKS = 1000;

// The 1/2/5×10ᵏ major step for a span targeting ~`targetCount` divisions (0 for a degenerate span):
// snap the raw span/count to the nearest number on that lattice (Heckbert's nice-number rule), which
// is what makes tick labels read as round.
export function niceStep(span: number, targetCount: number): number {
  const raw = span / Math.max(1, Math.floor(targetCount));
  if (!(raw > 0)) return 0;
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** exponent; // ∈ [1, 10)
  const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  return nice * 10 ** exponent;
}

// Ascending major ticks at a *given* step within [min, max] (inclusive, clipped). Lets several axes
// share one step for a uniform-spacing grid; a non-positive step or zero-width range degenerates to a
// single tick. Separated from the step choice so the lattice and the spacing decision compose.
export function ticksForStep(min: number, max: number, step: number): Omit<NiceTicks, "step"> {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!(step > 0) || !(hi > lo)) return { ticks: [lo], decimals: 0 };

  // Integer-indexed walk (i·step) avoids float drift that `v += step` accumulates over many ticks.
  const startIndex = Math.ceil(lo / step - 1e-9);
  const endIndex = Math.floor(hi / step + 1e-9);
  const ticks: number[] = [];
  for (let i = startIndex; i <= endIndex && ticks.length < MAX_TICKS; i++) {
    const value = i * step;
    ticks.push(value === 0 ? 0 : value); // normalize a -0 (from i=-0) to +0
  }

  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return { ticks, decimals };
}
