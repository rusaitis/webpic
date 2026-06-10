import { describe, expect, it } from "vitest";
import { fieldAxisToThree, formatTick, physicalToObject } from "./overlayRemap.ts";

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
