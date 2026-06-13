import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import { abs, float, max, sign, uniform } from "three/tsl";
import type { Node } from "three/webgpu";

// The domain half of the transfer function: maps a raw value → t∈[0,1] for the colormap LUT
// (transferFunction.ts is the range half, t → rgba). Window/level {center, width} picks the interval;
// `scale` picks how values map within it (linear / log / symlog). Both ride uniforms, so window and
// scale edits are live retunes, never a node rebuild. `windowedT` is the pure-TS twin the tests check
// and the TSL graph mirrors (the rayBox.ts ↔ hitBox precedent).

export type { WindowLevel };

const MIN_WIDTH = 1e-12; // width 0 collapses every value onto one color and divides by zero in-shader
const LOG_EPS = 1e-30; // floors log inputs so a non-positive lo/raw yields a finite (clamped) t, not NaN

/** Floor a window width's magnitude so the in-shader divide stays finite. */
export function safeWidth(width: number): number {
  return Math.max(Math.abs(width), MIN_WIDTH);
}

/** The full-range window over [vmin, vmax] — centered, spanning the whole interval (matplotlib's
 *  Normalize default, where vmin/vmax are the data limits). Mirrors the store's fullRangeWindow. */
export function fullRangeWindow(vmin: number, vmax: number): WindowLevel {
  return { center: (vmin + vmax) / 2, width: vmax - vmin };
}

// linear 0, log 1, symlog 2 — the in-shader uScaleMode value the TSL branches select on.
function scaleMode(scale: ColorScale): number {
  return scale === "log" ? 1 : scale === "symlog" ? 2 : 0;
}

// symlog linear half-width: |v|≤L is linear, beyond it logarithmic. Auto-derived from the window
// (the binding carries no linthresh in v0.1); matches rangeMath's guess (max|extent|/100).
function symlogThresh(lo: number, hi: number, override?: number): number {
  return Math.max(override ?? Math.max(Math.abs(lo), Math.abs(hi)) / 100, LOG_EPS);
}

/** Pure value→t reference for one (window, scale): the twin the TSL `toT` mirrors and tests check.
 *  Saturated to [0,1]. log/symlog floor their inputs so a non-positive window can't produce NaN. */
export function windowedT(
  raw: number,
  center: number,
  width: number,
  scale: ColorScale,
  linthresh?: number,
): number {
  const w = safeWidth(width);
  const lo = center - w / 2;
  const hi = center + w / 2;
  const den = (d: number): number => (d === 0 ? MIN_WIDTH : d);
  let t: number;
  if (scale === "log") {
    const e = (x: number): number => Math.log(Math.max(x, LOG_EPS));
    t = (e(raw) - e(lo)) / den(e(hi) - e(lo));
  } else if (scale === "symlog") {
    const L = symlogThresh(lo, hi, linthresh);
    const g = (v: number): number =>
      Math.abs(v) <= L ? v : Math.sign(v) * L * (1 + Math.log(Math.max(Math.abs(v) / L, LOG_EPS)));
    t = (g(raw) - g(lo)) / den(g(hi) - g(lo));
  } else {
    t = (raw - lo) / w; // hi − lo ≡ w (already floored), so no extra guard
  }
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export interface Normalization {
  /** map a raw field value → t∈[0,1] (saturated), mirroring windowedT for the active scale. */
  toT(raw: Node<"float">): Node<"float">;
  /** retune the window in place — no texture re-upload, no node rebuild. */
  setWindow(center: number, width: number): void;
  /** switch the value→color scale in place (uniform only). */
  setScale(scale: ColorScale): void;
}

/** Value→t normalization over a field's [vmin, vmax]; defaults to the full finite range, linear. */
export function createNormalization(
  vmin: number,
  vmax: number,
  wl?: WindowLevel,
  scale: ColorScale = "linear",
): Normalization {
  const window = wl ?? fullRangeWindow(vmin, vmax);
  const uCenter = uniform(window.center);
  const uWidth = uniform(safeWidth(window.width));
  const uScaleMode = uniform(scaleMode(scale));
  const eps = float(LOG_EPS);

  return {
    toT: (raw) => {
      const half = uWidth.mul(0.5);
      const lo = uCenter.sub(half);
      const hi = uCenter.add(half);

      // linear: (raw − lo)/(hi − lo); hi − lo ≡ uWidth (floored).
      const linearT = raw.sub(lo).div(uWidth);

      // log: ε-floored so a non-positive lo/raw stays finite (the UI keeps the log track positive;
      // this is the in-shader safety net).
      const logLo = max(lo, eps).log();
      const logT = max(raw, eps)
        .log()
        .sub(logLo)
        .div(max(max(hi, eps).log().sub(logLo), eps));

      // symlog: C¹ at ±L, linthresh L derived from the window.
      const L = max(max(abs(lo), abs(hi)).mul(1 / 100), eps);
      const g = (v: Node<"float">): Node<"float"> => {
        const av = abs(v);
        const compressed = sign(v)
          .mul(L)
          .mul(max(av.div(L), eps).log().add(1));
        return av.lessThanEqual(L).select(v, compressed);
      };
      const gLo = g(lo);
      const symT = g(raw)
        .sub(gLo)
        .div(max(g(hi).sub(gLo), eps));

      return uScaleMode.equal(2).select(symT, uScaleMode.equal(1).select(logT, linearT)).saturate();
    },
    setWindow(center, width) {
      uCenter.value = center;
      uWidth.value = safeWidth(width);
    },
    setScale(scale) {
      uScaleMode.value = scaleMode(scale);
    },
  };
}
