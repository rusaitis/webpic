// Pure value↔position math for the range slider (./rangeControl.ts). DOM-free and
// dependency-free so the semantics are unit-tested in isolation. Three concerns: snap a raw
// value to the drag step, map value↔normalized track position under a chosen scale
// (linear/log/symlog), and place tick marks.

import { clamp } from "@schema/math.ts";

// Re-exported so ./rangeControl and the range-math tests keep one import site.
export { clamp };

export type ScaleKind = "linear" | "log" | "symlog";

export interface Scale {
  readonly kind: ScaleKind;
  readonly min: number;
  readonly max: number;
  // symlog linear half-width around 0; 0 for linear/log.
  readonly linthresh: number;
  // value → normalized track position in [0, 1].
  toT(value: number): number;
  // normalized track position in [0, 1] → value.
  toValue(t: number): number;
}

// A fine step renders as a solid bar, so coarse sliders only.
const MAX_TICKS = 24;

// Sub-decade minor ticks: drawn only when the log/symlog tail spans ≤ MINOR_MAX_DECADES —
// past that the 2..9 marks smear together. MINOR_MAX_TICKS backstops pathological ranges.
const MINOR_MAX_DECADES = 3;
const MINOR_MAX_TICKS = 80;

// Quantize a dragged/keyed value to `step` (drag granularity only — typed text bypasses
// this so the grip can rest between steps). No step ⇒ clamp only.
export function snapToStep(raw: number, min: number, max: number, step?: number): number {
  const c = clamp(raw, min, max);
  if (step === undefined || !(step > 0)) return c;
  return clamp(min + Math.round((c - min) / step) * step, min, max);
}

// `minStep` floors the granularity near 0; the +ε guards log10's just-under-integer powers.
function decadeStep(a: number, minStep: number): number {
  if (!(a > 0)) return minStep > 0 ? minStep : 0;
  const d = 10 ** Math.floor(Math.log10(a) + 1e-9);
  return minStep > 0 ? Math.max(d, minStep) : d;
}

// Snap to the log-decade grid (see `decadeStep`): signed, ten divisions per decade,
// including 0. `minStep` floors the granularity near 0 and rounds sub-minStep magnitudes to
// exactly 0 — set it for symlog's linear band; omit for log (min > 0 bounds it). The
// scientific "nice value" feel (…, 10, 20, 50, 100, …) for log/symlog drag.
export function snapToDecade(raw: number, min: number, max: number, minStep = 0): number {
  const c = clamp(raw, min, max);
  const a = Math.abs(c);
  const d = decadeStep(a, minStep);
  if (!(d > 0)) return c;
  return clamp(Math.sign(c) * Math.round(a / d) * d, min, max);
}

// One cell along the log-decade grid from `cur` toward `dir` (±1) — the keyboard companion
// to `snapToDecade`. Stepping toward zero off a pure power of ten drops to the finer
// decade (10→9, 100→90) so the grid reads symmetrically; `minStep` bounds the finest cell.
export function stepDecade(
  cur: number,
  dir: 1 | -1,
  min: number,
  max: number,
  minStep = 0,
): number {
  const c = snapToDecade(cur, min, max, minStep);
  const a = Math.abs(c);
  let d = decadeStep(a, minStep);
  const towardZero = c !== 0 && dir !== Math.sign(c);
  if (towardZero && a > 0 && Math.abs(a / d - 1) < 1e-9) {
    d = minStep > 0 ? Math.max(d / 10, minStep) : d / 10;
  }
  return snapToDecade(c + dir * d, min, max, minStep);
}

// Pointer x → normalized [0, 1] across a track rect (the screen→param map).
export function pointerT(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 0;
  return clamp((clientX - rect.left) / rect.width, 0, 1);
}

// Build the value↔position bijection for a scale. `symlog` keeps a linear band of half-width
// `linthresh` around 0 and compresses the tails logarithmically — the high-dynamic-range
// signed-field case (B over ±1000 with detail at ±20).
export function makeScale(
  kind: ScaleKind,
  min: number,
  max: number,
  options: { linthresh?: number } = {},
): Scale {
  const span = max - min;

  if (kind === "log") {
    if (!(min > 0)) throw new RangeError(`log scale needs min > 0 (got ${min})`);
    const lmin = Math.log(min);
    const lspan = Math.log(max) - lmin;
    return {
      kind,
      min,
      max,
      linthresh: 0,
      toT: (v) => (lspan === 0 ? 0 : (Math.log(clamp(v, min, max)) - lmin) / lspan),
      toValue: (t) => Math.exp(lmin + clamp(t, 0, 1) * lspan),
    };
  }

  if (kind === "symlog") {
    const guess = Math.max(Math.abs(min), Math.abs(max)) / 100;
    const L =
      options.linthresh && options.linthresh > 0 ? options.linthresh : guess > 0 ? guess : 1;
    // g is C¹ at ±L (slope 1 matches the linear branch); inv is its exact inverse.
    const g = (v: number): number =>
      Math.abs(v) <= L ? v : Math.sign(v) * L * (1 + Math.log(Math.abs(v) / L));
    const inv = (y: number): number =>
      Math.abs(y) <= L ? y : Math.sign(y) * L * Math.exp(Math.abs(y) / L - 1);
    const gmin = g(min);
    const gspan = g(max) - gmin;
    return {
      kind,
      min,
      max,
      linthresh: L,
      toT: (v) => (gspan === 0 ? 0 : (g(clamp(v, min, max)) - gmin) / gspan),
      toValue: (t) => clamp(inv(gmin + clamp(t, 0, 1) * gspan), min, max),
    };
  }

  return {
    kind: "linear",
    min,
    max,
    linthresh: 0,
    toT: (v) => (span === 0 ? 0 : (clamp(v, min, max) - min) / span),
    toValue: (t) => min + clamp(t, 0, 1) * span,
  };
}

// Tick *values* (not positions) for a scale: linear → multiples of `step` (or `count` divisions)
// spanning [min, max]; log → 10ᵏ decades; symlog → 0 plus every ±10ᵏ decade within range, from the
// linthresh decade up. Ungated and unsorted-by-position — `tickPositions` maps + gates these,
// while the colorbar labels them directly (and thins its own decades).
export function tickValues(
  scale: Scale,
  options: { step?: number; count?: number } = {},
): number[] {
  const { kind, min, max, linthresh: L } = scale;
  const values: number[] = [];

  if (kind === "linear") {
    const step =
      options.step && options.step > 0
        ? options.step
        : options.count && options.count > 0
          ? span(min, max) / options.count
          : 0;
    if (!(step > 0)) return values;
    const n = Math.round(span(min, max) / step);
    for (let i = 0; i <= n; i++) values.push(min + i * step);
  } else if (kind === "log") {
    for (let k = Math.ceil(Math.log10(min)); k <= Math.floor(Math.log10(max)); k++) {
      values.push(10 ** k);
    }
  } else {
    // symlog → a power-of-ten ruler: 0 plus every decade ±10^k within range, from the
    // linthresh decade up. Reads as decades (0.1, 1, 10, 100, …), dense near 0.
    const maxAbs = Math.max(Math.abs(min), Math.abs(max));
    const decades: number[] = [];
    for (let k = Math.floor(Math.log10(L)); k <= Math.floor(Math.log10(maxAbs)); k++) {
      decades.push(10 ** k);
    }
    for (const v of [0, ...decades, ...decades.map((d) => -d)]) {
      if (v >= min && v <= max) values.push(v);
    }
  }
  return values;
}

// Tick VALUES → normalized positions: two values a micro-step apart land on the same pixel, so
// round to 1e-6 and drop the collisions before sorting — otherwise a log axis stacks labels.
function uniqueSortedPositions(scale: Scale, values: readonly number[]): number[] {
  const seen = new Set<number>();
  const positions: number[] = [];
  for (const value of values) {
    const t = Math.round(scale.toT(value) * 1e6) / 1e6;
    if (seen.has(t)) continue;
    seen.add(t);
    positions.push(t);
  }
  return positions.sort((a, b) => a - b);
}

// Tick positions in normalized [0, 1]. Linear → evenly by `step` (or `count`); log/symlog →
// decade lines. Empty when the count would exceed MAX_TICKS (renders as a solid bar).
export function tickPositions(
  scale: Scale,
  options: { step?: number; count?: number } = {},
): number[] {
  const values = tickValues(scale, options);
  if (values.length === 0) return [];
  // < 2 intervals (linear) or > MAX_TICKS marks reads as a solid bar — leave it to the gradient.
  if (scale.kind === "linear" && values.length < 3) return [];
  if (values.length > MAX_TICKS) return [];

  return uniqueSortedPositions(scale, values);
}

// Sub-decade minor-tick positions in normalized [0, 1] for log/symlog (the 2..9 ×10ᵏ marks
// within each decade). Empty for linear, and auto-decluttered to [] once the tail spans more
// than MINOR_MAX_DECADES.
export function minorTickPositions(scale: Scale): number[] {
  const { kind, min, max, linthresh: L } = scale;
  if (kind === "linear") return [];

  const maxAbs = Math.max(Math.abs(min), Math.abs(max));
  if (!(maxAbs > 0)) return [];
  const loDecade =
    kind === "log"
      ? Math.floor(Math.log10(Math.max(min, Number.MIN_VALUE)))
      : Math.floor(Math.log10(L > 0 ? L : maxAbs / 100));
  const hiDecade = Math.floor(Math.log10(maxAbs));
  if (hiDecade - loDecade > MINOR_MAX_DECADES) return [];

  const values: number[] = [];
  for (let k = loDecade; k <= hiDecade; k++) {
    const base = 10 ** k;
    for (let m = 2; m <= 9; m++) {
      const v = m * base;
      if (kind === "symlog" && v < L) continue; // inside the linear band
      if (v >= min && v <= max) values.push(v);
      if (kind === "symlog" && -v >= min && -v <= max) values.push(-v);
    }
  }
  if (values.length === 0 || values.length > MINOR_MAX_TICKS) return [];

  return uniqueSortedPositions(scale, values);
}

// Decimal places to render a {1,2,5}×10ᵏ `step` exactly: the negative decade of the step (0 for
// step ≥ 1). The +ε absorbs log10's just-under-integer powers.
export function stepDecimals(step: number): number {
  if (!(step > 0)) return 0;
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-12));
}

// Round a raw step UP to the nearest {1,2,5}×10ᵏ (sub-decade included: 0.1, 0.2, 0.5) — the
// Heckbert "nice numbers" step for ~`targetCount` intervals across `rawSpan`. 0 for a
// non-positive / non-finite span.
export function niceStep(rawSpan: number, targetCount: number): number {
  if (!(rawSpan > 0) || !Number.isFinite(rawSpan)) return 0;
  const raw = rawSpan / Math.max(1, targetCount);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag; // [1, 10)
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

export interface NiceTicks {
  // Tick values on the nice grid (integer multiples of `step`) within [lo, hi], ascending.
  readonly values: readonly number[];
  // The chosen nice step; 0 when degenerate (single value / empty). Drives label decimals.
  readonly step: number;
}

// Nice-number linear ticks: multiples of a {1,2,5}×10ᵏ step within [lo, hi] (matplotlib
// MaxNLocator style — round interior values, endpoints NOT forced). A range crossing 0 always
// includes exactly 0 (0 is a multiple of every step). A constant window (lo == hi) yields the lone
// value; a non-finite / empty range yields [].
export function niceLinearTicks(lo: number, hi: number, targetCount: number): NiceTicks {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { values: [], step: 0 };
  if (lo === hi) return { values: [lo], step: 0 };
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const step = niceStep(max - min, targetCount);
  if (!(step > 0)) return { values: [], step: 0 };
  const decimals = Math.min(stepDecimals(step), 20);
  const kStart = Math.ceil(min / step - 1e-9); // ε includes an endpoint sitting exactly on the grid
  const kEnd = Math.floor(max / step + 1e-9);
  const values: number[] = [];
  for (let k = kStart; k <= kEnd; k++) {
    values.push(Number((k * step).toFixed(decimals))); // snap to the grid, killing FP drift
  }
  return { values, step };
}

function span(min: number, max: number): number {
  return max - min;
}

// Clamp an interval into [min, max], preserving order and a minimum gap.
export function clampInterval(
  lo: number,
  hi: number,
  min: number,
  max: number,
  minGap = 0,
): [number, number] {
  const a = clamp(Math.min(lo, hi), min, max);
  let b = clamp(Math.max(lo, hi), min, max);
  let lower = a;
  if (b - lower < minGap) {
    b = Math.min(max, lower + minGap);
    lower = Math.max(min, b - minGap);
  }
  return [lower, b];
}

// Translate both ends by `delta`, clamped so the window stays within [min, max]. Width is
// preserved (drag-the-fill-moves-both-ends).
export function translateInterval(
  lo: number,
  hi: number,
  delta: number,
  min: number,
  max: number,
): [number, number] {
  const d = clamp(delta, min - lo, max - hi);
  return [lo + d, hi + d];
}

// The RangeControl is a general [lo, hi] interval; the store's canonical window is
// {center, width}. These convert at the panel↔store seam (no separate min/max in the store).

export interface WindowLevel {
  readonly center: number;
  readonly width: number;
}

// [lo, hi] → {center, width}.
export function intervalToWindow(lo: number, hi: number): WindowLevel {
  return { center: (lo + hi) / 2, width: hi - lo };
}

// {center, width} → [lo, hi].
export function windowToInterval(w: WindowLevel): [number, number] {
  return [w.center - w.width / 2, w.center + w.width / 2];
}
