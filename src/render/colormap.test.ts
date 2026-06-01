import { describe, expect, it } from "vitest";
import { type ColormapName, colormapColor, type Rgb, resolveColormapName } from "./colormap.ts";

const NAMES: readonly ColormapName[] = ["inferno", "viridis", "plasma", "magma"];
const SAMPLES = [0, 0.25, 0.5, 0.75, 1] as const;

// Rec. 709 luma — the perceptually-uniform sequentials all increase in luminance with t.
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("colormapColor", () => {
  it.each(NAMES)("%s rises monotonically in luminance (catches a garbled table)", (name) => {
    const lum = SAMPLES.map((t) => luminance(colormapColor(name, t)));
    for (let i = 1; i < lum.length; i++) {
      expect(lum[i] ?? 0).toBeGreaterThan(lum[i - 1] ?? 0);
    }
  });

  it.each(NAMES)("%s keeps every channel within [0,1]", (name) => {
    for (const t of SAMPLES) {
      for (const c of colormapColor(name, t)) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it("clamps t to [0,1] at both ends", () => {
    expect(colormapColor("inferno", -0.5)).toEqual(colormapColor("inferno", 0));
    expect(colormapColor("inferno", 1.5)).toEqual(colormapColor("inferno", 1));
  });

  it("spans dark→bright for inferno", () => {
    expect(luminance(colormapColor("inferno", 0))).toBeLessThan(0.05);
    expect(luminance(colormapColor("inferno", 1))).toBeGreaterThan(0.85);
  });
});

describe("resolveColormapName", () => {
  it("passes supported names through", () => {
    for (const name of NAMES) expect(resolveColormapName(name)).toBe(name);
  });

  it("falls back to inferno for diverging / unknown names", () => {
    expect(resolveColormapName("RdBu_r")).toBe("inferno");
    expect(resolveColormapName("cividis")).toBe("inferno");
    expect(resolveColormapName("nonsense")).toBe("inferno");
    // hasOwn guard: inherited props must not resolve as colormaps.
    expect(resolveColormapName("toString")).toBe("inferno");
  });

  it("routes unknown names through the inferno fit", () => {
    expect(colormapColor("nonsense", 0.42)).toEqual(colormapColor("inferno", 0.42));
  });
});
