import { uniform } from "three/tsl";
import type { Node } from "three/webgpu";

// The value→color window shared by the slice and raymarch materials: it maps
// [center − width/2, center + width/2] → [0,1] in TSL, then the caller samples the LUT at t.
// One home for the formula, the uniforms, and the width guard.

export interface WindowLevel {
  readonly center: number;
  readonly width: number;
}

const MIN_WIDTH = 1e-12; // width 0 collapses every value onto one color and divides by zero in-shader

/** Floor a window width's magnitude so the in-shader divide stays finite. */
export function safeWidth(width: number): number {
  return Math.max(Math.abs(width), MIN_WIDTH);
}

/** The full-range window: center the field's [min, max], width its span. */
export function defaultWindow(min: number, max: number): WindowLevel {
  return { center: (min + max) / 2, width: max - min };
}

export interface WindowLevelUniforms {
  /** map a raw field value → t∈[0,1] (saturated). */
  normalize(raw: Node<"float">): Node<"float">;
  /** retune the window in place — no texture re-upload. */
  setWindowLevel(center: number, width: number): void;
}

/** Window/level uniforms over a field's [min, max]; defaults to the full finite range. */
export function createWindowLevel(min: number, max: number, wl?: WindowLevel): WindowLevelUniforms {
  const window = wl ?? defaultWindow(min, max);
  const uCenter = uniform(window.center);
  const uWidth = uniform(safeWidth(window.width));
  return {
    normalize: (raw) => raw.sub(uCenter).div(uWidth).add(0.5).saturate(),
    setWindowLevel(center, width) {
      uCenter.value = center;
      uWidth.value = safeWidth(width);
    },
  };
}
