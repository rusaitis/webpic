import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from "three";
import { colormapColor } from "./colormap.ts";

// The colormap baked as a 256×1 rgba16float LUT, sampled in the slice/raymarch materials at
// the windowed value t∈[0,1]. Sourced from the colormap.ts CPU polynomial, so a reified
// ColormapBinding and the opacity transfer function build on a texture, not a node graph.
// rgba16float is linear-filterable in core WebGPU — same half-float path the volume uses.

const DEFAULT_LUT_SIZE = 256; // conventional colormap LUT width (linear-interpolated texels)

export interface TransferFunctionTexture {
  readonly texture: DataTexture;
  /** Rebake the LUT for a new colormap in place (no reallocation). Idempotent — a repeated name is
   *  a no-op, so a window-drag message carrying the unchanged colormap costs nothing. */
  setColormap(name: string): void;
  dispose(): void;
}

/** Sample `name`'s colormap into a packed RGBA half-float LUT (`size` texels wide).
 *  Alpha is 1.0 throughout — the opacity transfer function (alpha curve) lands later;
 *  for now the slice is opaque and the raymarch keeps its value-proportional opacity. */
export function buildTransferFunctionLut(name: string, size = DEFAULT_LUT_SIZE): Uint16Array {
  const lut = new Uint16Array(size * 4);
  const one = DataUtils.toHalfFloat(1);
  const last = size - 1;
  for (let i = 0; i < size; i++) {
    const [r, g, b] = colormapColor(name, i / last);
    const o = i * 4;
    lut[o] = DataUtils.toHalfFloat(r);
    lut[o + 1] = DataUtils.toHalfFloat(g);
    lut[o + 2] = DataUtils.toHalfFloat(b);
    lut[o + 3] = one;
  }
  return lut;
}

/** Build a 256×1 rgba16float `DataTexture` colormap LUT for `name`. Linear-filtered so the
 *  shader interpolates between texels; clamp-to-edge holds the endpoint colors. */
export function createTransferFunctionTexture(
  name: string,
  size = DEFAULT_LUT_SIZE,
): TransferFunctionTexture {
  const texture = new DataTexture(
    buildTransferFunctionLut(name, size),
    size,
    1,
    RGBAFormat,
    HalfFloatType,
  );
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true; // mandatory — the backend never uploads otherwise
  let current = name;
  return {
    texture,
    setColormap(next) {
      if (next === current) return; // idempotent — skip the rebake on an unchanged colormap
      current = next;
      (texture.image.data as Uint16Array).set(buildTransferFunctionLut(next, size));
      texture.needsUpdate = true;
    },
    dispose() {
      texture.dispose();
    },
  };
}
