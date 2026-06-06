import { FloatType, HalfFloatType, LinearFilter } from "three";
import { describe, expect, it } from "vitest";
import { createVolumeTexture, type ScalarField } from "./volumeTexture.ts";

const field = (): ScalarField => ({
  data: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
  shape: [2, 2, 2],
});

describe("createVolumeTexture", () => {
  it("uploads R32F + linear when float32-filterable is available (the stable Metal path)", () => {
    const volume = createVolumeTexture(field(), true);
    expect(volume.texture.type).toBe(FloatType);
    expect(volume.texture.image.data).toBeInstanceOf(Float32Array);
    expect(volume.texture.minFilter).toBe(LinearFilter);
    volume.dispose();
  });

  it("falls back to R16F (half-float) when float32-filterable is absent", () => {
    const volume = createVolumeTexture(field(), false);
    expect(volume.texture.type).toBe(HalfFloatType);
    expect(volume.texture.image.data).toBeInstanceOf(Uint16Array);
    volume.dispose();
  });

  it("reports the finite data range regardless of format", () => {
    const volume = createVolumeTexture(field(), true);
    expect(volume.min).toBe(0);
    expect(volume.max).toBe(7);
    volume.dispose();
  });
});
