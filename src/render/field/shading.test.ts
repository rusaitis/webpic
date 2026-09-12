import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { GRAD_EPS, gradientToNormal, headlightShade, PHONG } from "./shading.ts";

const view: Vec3 = [0, 0, 1]; // headlight down +z

describe("gradientToNormal", () => {
  it("normalizes a finite gradient to unit length", () => {
    const n = gradientToNormal([0, 3, 4], view);
    expect(Math.hypot(...n)).toBeCloseTo(1, 12);
    expect(n).toEqual([0, 0.6, 0.8]);
  });

  it("preserves direction", () => {
    const n = gradientToNormal([2, 0, 0], view);
    expect(n).toEqual([1, 0, 0]);
  });

  it("falls back when the field is locally flat (|grad| ≤ ε)", () => {
    expect(gradientToNormal([0, 0, 0], view)).toBe(view);
    expect(gradientToNormal([GRAD_EPS / 2, 0, 0], view)).toBe(view);
  });
});

describe("headlightShade", () => {
  it("is brightest head-on (n ∥ view): ambient + diffuse + specular", () => {
    expect(headlightShade(view, view)).toBeCloseTo(
      PHONG.ambient + PHONG.diffuse + PHONG.specular,
      12,
    );
  });

  it("is ambient-only edge-on (n ⟂ view)", () => {
    expect(headlightShade([1, 0, 0], view)).toBeCloseTo(PHONG.ambient, 12);
  });

  it("is two-sided: a back-facing normal lights identically", () => {
    const front = headlightShade(view, view);
    const back = headlightShade([0, 0, -1], view); // flipped toward the viewer first
    expect(back).toBeCloseTo(front, 12);
  });

  it("decreases monotonically as the normal tilts away from the view", () => {
    const tilt = (deg: number): number => {
      const r = (deg * Math.PI) / 180;
      return headlightShade([Math.sin(r), 0, Math.cos(r)], view);
    };
    expect(tilt(0)).toBeGreaterThan(tilt(30));
    expect(tilt(30)).toBeGreaterThan(tilt(60));
    expect(tilt(60)).toBeGreaterThan(tilt(89));
  });

  it("never falls below ambient (the floor that keeps unlit regions visible)", () => {
    for (const deg of [0, 45, 90, 135, 180]) {
      const r = (deg * Math.PI) / 180;
      expect(headlightShade([Math.sin(r), 0, Math.cos(r)], view)).toBeGreaterThanOrEqual(
        PHONG.ambient - 1e-12,
      );
    }
  });
});
