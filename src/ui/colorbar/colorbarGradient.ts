import { type ColormapId, colormapColor } from "@schema/colormap.ts";
import {
  makeScale,
  niceLinearTicks,
  type ScaleKind,
  stepDecimals,
  tickValues,
  type WindowLevel,
  windowToInterval,
} from "../controls/rangeMath.ts";

// Pure painters for the floating colorbar: the gradient strip (canvas, sampled from the same
// analytic colormap the GPU LUT is baked from — so the strip and the rendered volume agree) and
// the numeric tick labels (value↔position via the slider's own scale math, so the strip and the
// window slider read the same). No store, no DOM mutation beyond the passed canvas.

const GRADIENT_STEPS = 64; // smooth enough; the canvas scales to the CSS strip size

// Paint `colormapId` into `canvas` as a linear gradient. Vertical strips put the maximum at the
// top (stop = 1−t); horizontal strips put it on the right (stop = t). No-op without a 2D context
// (e.g. happy-dom) so callers stay crash-free in tests.
export function paintGradient(
  canvas: HTMLCanvasElement,
  colormapId: ColormapId,
  isHorizontal: boolean,
): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  const gradient = isHorizontal
    ? ctx.createLinearGradient(0, 0, w, 0)
    : ctx.createLinearGradient(0, 0, 0, h);
  for (let i = 0; i <= GRADIENT_STEPS; i++) {
    const t = i / GRADIENT_STEPS;
    const [r, g, b] = colormapColor(colormapId, t);
    const stop = isHorizontal ? t : 1 - t; // vertical: top is max
    gradient.addColorStop(stop, `rgb(${r * 255}, ${g * 255}, ${b * 255})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

export interface ColorbarTick {
  // Normalized position along the gradient from the minimum (0) to the maximum (1).
  readonly t: number;
  readonly label: string;
}

// Outside this magnitude band, fixed notation either loses every significant digit or runs past the
// strip's width, so the readout switches to exponential. One pair of bounds for the value readout
// and the tick set, so the strip and the slider never disagree about which notation a number gets.
const NOTATION_MIN = 1e-3;
const NOTATION_MAX = 1e4;

// Compact readout: exponential for very small/large magnitudes, ~4 sig figs otherwise. Shared
// with the colormap controls so the strip and the slider format identically.
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < NOTATION_MIN || a >= NOTATION_MAX)) return v.toExponential(2);
  return Number(v.toPrecision(4)).toString();
}

// Format a whole tick set coherently: one decimal count derived from `step`, so {0, 0.2, 0.4} reads
// as "0.0 0.2 0.4" — not "0 0.2 0.4000001". Falls back to uniform exponential (matching
// `formatValue`'s thresholds) when the step or the largest magnitude is extreme; in that
// branch zero renders a bare "0" rather than "0.00e+0". `-0` is normalized to `0`.
export function formatTicks(values: readonly number[], step: number): string[] {
  if (values.length === 0) return [];
  let maxAbs = 0;
  for (const v of values) maxAbs = Math.max(maxAbs, Math.abs(v));
  const extreme =
    step > 0
      ? step < NOTATION_MIN || maxAbs >= NOTATION_MAX
      : maxAbs !== 0 && (maxAbs < NOTATION_MIN || maxAbs >= NOTATION_MAX);
  const decimals = Math.min(stepDecimals(step), 12);
  return values.map((v) => {
    const z = Object.is(v, -0) ? 0 : v;
    if (extreme) return z === 0 ? "0" : z.toExponential(2);
    return z.toFixed(decimals);
  });
}

// Thin a decade list toward `maxCount` for the colorbar, keeping every stride-th decade plus the
// extremes and zero (symlog's center) for context. Wider than the slider's hard MAX_TICKS cap,
// which would otherwise blank a many-decade ruler entirely. Expects ascending input.
function thinDecades(values: readonly number[], maxCount: number): number[] {
  if (values.length <= maxCount) return values.slice();
  const stride = Math.ceil(values.length / maxCount);
  const kept = new Set<number>();
  let i = 0;
  for (const v of values) {
    if (i % stride === 0 || v === 0) kept.add(v);
    i++;
  }
  const first = values.at(0);
  const last = values.at(-1);
  if (first !== undefined) kept.add(first);
  if (last !== undefined) kept.add(last);
  return [...kept].sort((a, b) => a - b);
}

// Nice-number tick set across the window under `scale`, sized to ≈ `targetCount` ticks. Linear →
// round {1,2,5}×10ᵏ values (a signed window always gets an exact 0); log/symlog → a decade ruler
// (0, ±10ᵏ), thinned when the range spans many decades. Positions come from the slider's own scale
// math, so the strip and the window slider agree; symlog uses the renderer's default linthresh
// (max|extent|/100), so ticks line up with the painted gradient. log falls back to a linear read
// if the window reaches ≤ 0.
// Both tick paths degenerate the same way: no tick fits, so label the window's ends.
function endpointTicks(lo: number, hi: number): ColorbarTick[] {
  return [
    { t: 0, label: formatValue(lo) },
    { t: 1, label: formatValue(hi) },
  ];
}

export function tickLabels(
  window: WindowLevel,
  scale: ScaleKind,
  targetCount: number,
): ColorbarTick[] {
  const [lo, hi] = windowToInterval(window);
  const safeScale: ScaleKind = scale === "log" && lo <= 0 ? "linear" : scale;
  const s = makeScale(safeScale, lo, hi);

  if (safeScale === "linear") {
    const { values, step } = niceLinearTicks(lo, hi, targetCount);
    if (values.length === 0) return endpointTicks(lo, hi);
    if (values.length === 1) {
      const [only = lo] = values; // constant window: one centered readout
      return [{ t: 0.5, label: formatValue(only) }];
    }
    const labels = formatTicks(values, step);
    return values
      .map((v, i) => ({ t: s.toT(v), label: labels[i] ?? formatValue(v) }))
      .sort((a, b) => a.t - b.t);
  }

  // log / symlog → a decade ruler (majors only). Decades are compact and evenly spread on screen, so
  // the colorbar tolerates more of them than linear ticks — only a truly many-decade range thins.
  const values = thinDecades(
    tickValues(s).sort((a, b) => a - b),
    Math.max(targetCount, 7),
  );
  if (values.length === 0) return endpointTicks(lo, hi);
  return values.map((v) => ({ t: s.toT(v), label: formatValue(v) })).sort((a, b) => a.t - b.t);
}
