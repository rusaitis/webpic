// Pure value↔position math for the range slider (./rangeControl.ts). DOM-free and
// dependency-free so the semantics are unit-tested in isolation. Three concerns: snap a raw
// value to the drag step, map value↔normalized track position under a chosen scale
// (linear/log/symlog), and place tick marks. Ported from magviz's controls.

export type ScaleKind = "linear" | "log" | "symlog";

export interface Scale {
  readonly kind: ScaleKind;
  readonly min: number;
  readonly max: number;
  /** symlog linear half-width around 0; 0 for linear/log. */
  readonly linthresh: number;
  /** value → normalized track position in [0, 1]. */
  toT(value: number): number;
  /** normalized track position in [0, 1] → value. */
  toValue(t: number): number;
}

// A fine step renders as a solid bar, so coarse sliders only.
const MAX_TICKS = 24;

// Sub-decade minor ticks: drawn only when the log/symlog tail spans ≤ MINOR_MAX_DECADES —
// past that the 2..9 marks smear together. MINOR_MAX_TICKS backstops pathological ranges.
const MINOR_MAX_DECADES = 3;
const MINOR_MAX_TICKS = 80;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Quantize a dragged/keyed value to `step` (drag granularity only — typed text bypasses
 *  this so the grip can rest between steps). No step ⇒ clamp only. */
export function snapToStep(raw: number, min: number, max: number, step?: number): number {
  const c = clamp(raw, min, max);
  if (step === undefined || !(step > 0)) return c;
  return clamp(min + Math.round((c - min) / step) * step, min, max);
}

/** The log-decade step at magnitude `a`: `10^floor(log10 a)`. `minStep` floors the
 *  granularity near 0. The +ε guards log10's just-under-integer powers. */
function decadeStep(a: number, minStep: number): number {
  if (!(a > 0)) return minStep > 0 ? minStep : 0;
  const d = 10 ** Math.floor(Math.log10(a) + 1e-9);
  return minStep > 0 ? Math.max(d, minStep) : d;
}

/** Snap to the log-decade grid (see {@link decadeStep}): signed, ten divisions per decade,
 *  including 0. `minStep` floors the granularity near 0 and rounds sub-minStep magnitudes to
 *  exactly 0 — set it for symlog's linear band; omit for log (min > 0 bounds it). The
 *  scientific "nice value" feel (…, 10, 20, 50, 100, …) for log/symlog drag. */
export function snapToDecade(raw: number, min: number, max: number, minStep = 0): number {
  const c = clamp(raw, min, max);
  const a = Math.abs(c);
  const d = decadeStep(a, minStep);
  if (!(d > 0)) return c;
  return clamp(Math.sign(c) * Math.round(a / d) * d, min, max);
}

/** One cell along the log-decade grid from `cur` toward `dir` (±1) — the keyboard companion
 *  to {@link snapToDecade}. Stepping toward zero off a pure power of ten drops to the finer
 *  decade (10→9, 100→90) so the grid reads symmetrically; `minStep` bounds the finest cell. */
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

/** Pointer x → normalized [0, 1] across a track rect (the screen→param map). */
export function pointerT(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 0;
  return clamp((clientX - rect.left) / rect.width, 0, 1);
}

/** Build the value↔position bijection for a scale. `symlog` keeps a linear band of half-width
 *  `linthresh` around 0 and compresses the tails logarithmically — the high-dynamic-range
 *  signed-field case (B over ±1000 with detail at ±20). */
export function makeScale(
  kind: ScaleKind,
  min: number,
  max: number,
  opts: { linthresh?: number } = {},
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
    const L = opts.linthresh && opts.linthresh > 0 ? opts.linthresh : guess > 0 ? guess : 1;
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

/** Tick positions in normalized [0, 1]. Linear → evenly by `step` (or `count`); log/symlog →
 *  decade lines. Empty when the count would exceed MAX_TICKS (renders as a solid bar). */
export function tickPositions(
  scale: Scale,
  opts: { step?: number; count?: number } = {},
): number[] {
  const { kind, min, max, linthresh: L } = scale;
  const values: number[] = [];

  if (kind === "linear") {
    const step =
      opts.step && opts.step > 0
        ? opts.step
        : opts.count && opts.count > 0
          ? span(min, max) / opts.count
          : 0;
    if (!(step > 0)) return [];
    const n = Math.round(span(min, max) / step);
    if (n < 2 || n > MAX_TICKS) return [];
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

  if (values.length === 0 || values.length > MAX_TICKS) return [];
  const seen = new Set<number>();
  const ts: number[] = [];
  for (const v of values) {
    const t = Math.round(scale.toT(v) * 1e6) / 1e6;
    if (!seen.has(t)) {
      seen.add(t);
      ts.push(t);
    }
  }
  return ts.sort((a, b) => a - b);
}

/** Sub-decade minor-tick positions in normalized [0, 1] for log/symlog (the 2..9 ×10ᵏ marks
 *  within each decade). Empty for linear, and auto-decluttered to [] once the tail spans more
 *  than MINOR_MAX_DECADES. */
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

  const seen = new Set<number>();
  const ts: number[] = [];
  for (const v of values) {
    const t = Math.round(scale.toT(v) * 1e6) / 1e6;
    if (!seen.has(t)) {
      seen.add(t);
      ts.push(t);
    }
  }
  return ts.sort((a, b) => a - b);
}

function span(min: number, max: number): number {
  return max - min;
}

/** Clamp an interval into [min, max], preserving order and a minimum gap. */
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

/** Translate both ends by `delta`, clamped so the window stays within [min, max]. Width is
 *  preserved (drag-the-fill-moves-both-ends). */
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

// --- window/level boundary conversions ---------------------------------------------------
// The RangeControl is a general [lo, hi] interval; the store's canonical window is
// {center, width}. These convert at the panel↔store seam (no separate min/max in the store).

export interface Window {
  readonly center: number;
  readonly width: number;
}

/** [lo, hi] → {center, width}. */
export function intervalToWindow(lo: number, hi: number): Window {
  return { center: (lo + hi) / 2, width: hi - lo };
}

/** {center, width} → [lo, hi]. */
export function windowToInterval(w: Window): [number, number] {
  return [w.center - w.width / 2, w.center + w.width / 2];
}
