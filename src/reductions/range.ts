import type { FloatArray } from "@schema/types.ts";

// Single-pass finite-only extrema — the value-range reductions the store's default window, the volume
// texture's NaN fill, and the worker's pick fallback all read. One definition so they cannot drift.

export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

/** Finite-only min/max. A constant field is widened by 1 so a window over it has a finite width;
 *  null when no sample is finite (an all-NaN step). */
export function finiteRange(data: FloatArray): ValueRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return null;
  if (min === max) return { min, max: max + 1 };
  return { min, max };
}

/** Finite-only minimum, or null when no sample is finite. Cheaper than finiteRange on a per-scrub-step
 *  path that never reads the max (the texture upload's NaN fill). */
export function finiteMin(data: FloatArray): number | null {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v < min) min = v;
  }
  return min === Number.POSITIVE_INFINITY ? null : min;
}
