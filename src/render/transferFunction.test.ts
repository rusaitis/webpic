import { DataUtils, HalfFloatType, RGBAFormat } from "three";
import { describe, expect, it } from "vitest";
import { colormapColor } from "./colormap.ts";
import { buildTransferFunctionLut, createTransferFunctionTexture } from "./transferFunction.ts";

// Half-float carries ~11 significand bits → values in [0,1] round-trip to ~5e-4; 3 decimals is comfortable.
const HALF_FLOAT_PLACES = 3;

describe("buildTransferFunctionLut", () => {
  it("packs `size` RGBA texels with opaque alpha", () => {
    const lut = buildTransferFunctionLut("inferno", 256);
    expect(lut.length).toBe(256 * 4);
    for (let i = 0; i < 256; i++) {
      expect(DataUtils.fromHalfFloat(lut[i * 4 + 3] ?? 0)).toBe(1);
    }
  });

  it("reproduces the colormap endpoints (the LUT is baked from colormapColor)", () => {
    const lut = buildTransferFunctionLut("viridis", 256);
    const decode = (texel: number): readonly [number, number, number] => [
      DataUtils.fromHalfFloat(lut[texel * 4] ?? 0),
      DataUtils.fromHalfFloat(lut[texel * 4 + 1] ?? 0),
      DataUtils.fromHalfFloat(lut[texel * 4 + 2] ?? 0),
    ];
    const [r0, g0, b0] = colormapColor("viridis", 0);
    const [r1, g1, b1] = colormapColor("viridis", 1);
    const [lr0, lg0, lb0] = decode(0);
    const [lr1, lg1, lb1] = decode(255);
    expect(lr0).toBeCloseTo(r0, HALF_FLOAT_PLACES);
    expect(lg0).toBeCloseTo(g0, HALF_FLOAT_PLACES);
    expect(lb0).toBeCloseTo(b0, HALF_FLOAT_PLACES);
    expect(lr1).toBeCloseTo(r1, HALF_FLOAT_PLACES);
    expect(lg1).toBeCloseTo(g1, HALF_FLOAT_PLACES);
    expect(lb1).toBeCloseTo(b1, HALF_FLOAT_PLACES);
  });

  it("falls back to inferno for an unknown colormap name", () => {
    expect(buildTransferFunctionLut("not-a-colormap")).toEqual(buildTransferFunctionLut("inferno"));
  });
});

describe("createTransferFunctionTexture", () => {
  it("builds a 256×1 rgba16float DataTexture", () => {
    const tf = createTransferFunctionTexture("magma");
    expect(tf.texture.image.width).toBe(256);
    expect(tf.texture.image.height).toBe(1);
    expect(tf.texture.format).toBe(RGBAFormat);
    expect(tf.texture.type).toBe(HalfFloatType);
    tf.dispose();
  });
});
