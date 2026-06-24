import { CanvasTexture, LinearFilter, type Texture } from "three";

// Finish a 2D-drawn OffscreenCanvas into a sampled THREE texture: linear min/mag, no mipmaps. Shared
// by the overlay labels (grid/overlayScene) and the marker sprites (marker/markerScene) — both draw
// glyphs/icons once per scene build and want crisp bilinear sampling without a mip chain.
export function finishCanvasTexture(canvas: OffscreenCanvas): Texture {
  const tex = new CanvasTexture(canvas);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}
