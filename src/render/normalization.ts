import { uniform } from "three/tsl";
import type { Node } from "three/webgpu";

// The domain half of the transfer function: maps a raw scalar value → t∈[0,1], which the
// slice/raymarch materials then sample the colormap LUT at (transferFunction.ts is the range
// half, t → rgba). Built from a window/level today — a linear map over [center−w/2, center+w/2];
// log/symlog variants land with the M2.4 ColormapBinding. One home for the map, the uniforms,
// and the width guard.

export interface WindowLevel {
  readonly center: number;
  readonly width: number;
}

const MIN_WIDTH = 1e-12; // width 0 collapses every value onto one color and divides by zero in-shader

/** Floor a window width's magnitude so the in-shader divide stays finite. */
export function safeWidth(width: number): number {
  return Math.max(Math.abs(width), MIN_WIDTH);
}

/** The full-range window over [vmin, vmax] — centered, spanning the whole interval (matplotlib's
 *  Normalize default, where vmin/vmax are the data limits). Mirrors the store's fullRangeWindow. */
export function fullRangeWindow(vmin: number, vmax: number): WindowLevel {
  return { center: (vmin + vmax) / 2, width: vmax - vmin };
}

export interface Normalization {
  /** map a raw field value → t∈[0,1] (saturated), mirroring the UI scale's toT. */
  toT(raw: Node<"float">): Node<"float">;
  /** retune the window in place — no texture re-upload. */
  setWindow(center: number, width: number): void;
}

/** Value→t normalization over a field's [vmin, vmax]; defaults to the full finite range. */
export function createNormalization(vmin: number, vmax: number, wl?: WindowLevel): Normalization {
  const window = wl ?? fullRangeWindow(vmin, vmax);
  const uCenter = uniform(window.center);
  const uWidth = uniform(safeWidth(window.width));
  return {
    toT: (raw) => raw.sub(uCenter).div(uWidth).add(0.5).saturate(),
    setWindow(center, width) {
      uCenter.value = center;
      uWidth.value = safeWidth(width);
    },
  };
}
