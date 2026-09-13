/** Linear-interpolated quantile of an ascending-sorted sample; NaN on empty input. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[hi] ?? Number.NaN;
  return a + (b - a) * (pos - lo);
}

export interface Summary {
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly last: number;
  readonly count: number;
}

/** Drop non-finite samples, then the four numbers every instrument reports. */
export function summarize(samples: readonly number[]): Summary {
  const finite = samples.filter(Number.isFinite);
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
    p50: quantile(sorted, 0.5),
    last: finite[finite.length - 1] ?? Number.NaN,
    count: finite.length,
  };
}
