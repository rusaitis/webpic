import { describe, expect, it } from "vitest";
import {
  fieldAxisToThree,
  formatTick,
  LABEL_FADE_FULL_COS,
  LABEL_FADE_START_COS,
  labelFadeOpacity,
  physicalToObject,
} from "./overlayRemap.ts";

describe("fieldAxisToThree", () => {
  it("maps field axes to world axes by identity (z-up, world=physical; swizzle in the sampler)", () => {
    expect(fieldAxisToThree(0)).toBe(0); // field axis 0 → world x
    expect(fieldAxisToThree(1)).toBe(1); // field axis 1 → world y
    expect(fieldAxisToThree(2)).toBe(2); // field axis 2 → world z (up)
  });
});

describe("physicalToObject", () => {
  it("maps the bounds onto the unit box faces", () => {
    expect(physicalToObject(0, 0, 10)).toBe(-0.5);
    expect(physicalToObject(10, 0, 10)).toBe(0.5);
    expect(physicalToObject(2.5, 0, 10)).toBe(-0.25);
  });
  it("handles a non-zero origin and a zero-width span", () => {
    expect(physicalToObject(-5, -5, 5)).toBe(-0.5);
    expect(physicalToObject(0, -5, 5)).toBe(0);
    expect(physicalToObject(3, 3, 3)).toBe(-0.5); // degenerate → lower face, no NaN
  });
  it("scales to a non-cubic axis's world half-extent", () => {
    // A short axis (halfExtent 1/3) maps its bounds into [-1/3, 1/3] — the scaled volume box.
    expect(physicalToObject(0, -5, 5, 1 / 3)).toBeCloseTo(0, 12);
    expect(physicalToObject(5, -5, 5, 1 / 3)).toBeCloseTo(1 / 3, 12);
    expect(physicalToObject(-5, -5, 5, 1 / 3)).toBeCloseTo(-1 / 3, 12);
    expect(physicalToObject(3, 3, 3, 1 / 3)).toBe(-1 / 3); // degenerate → lower face
  });
});

describe("formatTick", () => {
  it("respects the precision and strips a negative-zero artifact", () => {
    expect(formatTick(250, 0)).toBe("250");
    expect(formatTick(0.2, 1)).toBe("0.2");
    expect(formatTick(-0, 2)).toBe("0.00");
    expect(formatTick(-0.0001, 2)).toBe("0.00");
    expect(formatTick(-12.5, 1)).toBe("-12.5");
  });
});

describe("labelFadeOpacity", () => {
  const cosAt = (deg: number) => Math.cos((deg * Math.PI) / 180);

  it("is fully opaque beyond 35° off-axis and fully gone within 15°", () => {
    expect(labelFadeOpacity(cosAt(90))).toBe(1); // perpendicular view
    expect(labelFadeOpacity(cosAt(51))).toBe(1); // the default 3/4 view's rows
    expect(labelFadeOpacity(LABEL_FADE_START_COS)).toBe(1);
    expect(labelFadeOpacity(LABEL_FADE_FULL_COS)).toBe(0);
    expect(labelFadeOpacity(cosAt(0))).toBe(0); // dead-on
  });

  it("crosses 0.5 at the band midpoint and decreases monotonically through it", () => {
    const mid = (LABEL_FADE_START_COS + LABEL_FADE_FULL_COS) / 2;
    expect(labelFadeOpacity(mid)).toBeCloseTo(0.5, 12);
    let prev = labelFadeOpacity(cosAt(40));
    for (let deg = 39; deg >= 10; deg--) {
      const next = labelFadeOpacity(cosAt(deg));
      expect(next).toBeLessThanOrEqual(prev);
      prev = next;
    }
  });
});
