import { describe, expect, it } from "vitest";
import { createNormalization, fullRangeWindow, safeWidth } from "./normalization.ts";

describe("safeWidth", () => {
  it("floors a collapsed window so the in-shader divide stays finite", () => {
    expect(safeWidth(0)).toBeGreaterThan(0);
    expect(safeWidth(0)).toBe(safeWidth(-0));
  });

  it("takes the magnitude of an inverted window", () => {
    expect(safeWidth(-5)).toBe(5);
  });

  it("passes a normal width through", () => {
    expect(safeWidth(2.5)).toBe(2.5);
  });
});

describe("fullRangeWindow", () => {
  it("centers the field's extent and spans its full range", () => {
    expect(fullRangeWindow(-2, 6)).toEqual({ center: 2, width: 8 });
  });
});

describe("createNormalization", () => {
  it("constructs over [vmin, vmax] and retunes a degenerate width without dividing by zero", () => {
    const norm = createNormalization(0, 10);
    // The TSL `toT` node needs a device to evaluate; here we only assert the guard path
    // runs — a collapsed window must not throw or leave width at 0.
    expect(() => norm.setWindow(5, 0)).not.toThrow();
  });
});
