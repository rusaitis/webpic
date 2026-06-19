import { type ColormapId, colormapColor } from "@schema/colormap.ts";
import {
  makeScale,
  type ScaleKind,
  type WindowLevel,
  windowToInterval,
} from "../controls/rangeMath.ts";

// Pure painters for the floating colorbar: the gradient strip (canvas, sampled from the same
// analytic colormap the GPU LUT is baked from — so the strip and the rendered volume agree) and
// the numeric tick labels (value↔position via the slider's own scale math, so the strip and the
// window slider read the same). No store, no DOM mutation beyond the passed canvas.

const GRADIENT_STEPS = 64; // smooth enough; the canvas scales to the CSS strip size

/** Paint `colormapId` into `canvas` as a linear gradient. Vertical strips put the maximum at the
 *  top (stop = 1−t); horizontal strips put it on the right (stop = t). No-op without a 2D context
 *  (e.g. happy-dom) so callers stay crash-free in tests. */
export function paintGradient(
  canvas: HTMLCanvasElement,
  colormapId: ColormapId,
  horizontal: boolean,
): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  const gradient = horizontal
    ? ctx.createLinearGradient(0, 0, w, 0)
    : ctx.createLinearGradient(0, 0, 0, h);
  for (let i = 0; i <= GRADIENT_STEPS; i++) {
    const t = i / GRADIENT_STEPS;
    const [r, g, b] = colormapColor(colormapId, t);
    const stop = horizontal ? t : 1 - t; // vertical: top is max
    gradient.addColorStop(stop, `rgb(${r * 255}, ${g * 255}, ${b * 255})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

export interface ColorbarTick {
  /** Normalized position along the gradient from the minimum (0) to the maximum (1). */
  readonly t: number;
  readonly label: string;
}

/** Compact readout: exponential for very small/large magnitudes, ~4 sig figs otherwise. Shared
 *  with the colormap controls so the strip and the slider format identically. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e4)) return v.toExponential(2);
  return Number(v.toPrecision(4)).toString();
}

/** `count` tick values across the window under `scale`, evenly spaced in track position. The
 *  caller places them (top→bottom for vertical, left→right for horizontal). log falls back to a
 *  linear read if the window reaches ≤ 0 (the slider's positive track floor normally prevents it).*/
export function tickLabels(window: WindowLevel, scale: ScaleKind, count = 5): ColorbarTick[] {
  const [lo, hi] = windowToInterval(window);
  const safeScale: ScaleKind = scale === "log" && lo <= 0 ? "linear" : scale;
  const s = makeScale(safeScale, lo, hi);
  const ticks: ColorbarTick[] = [];
  const last = Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const t = i / last;
    ticks.push({ t, label: formatValue(s.toValue(t)) });
  }
  return ticks;
}
