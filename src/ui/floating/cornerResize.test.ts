import { describe, expect, it } from "vitest";
import { resizeDims } from "./cornerResize.ts";

const BOUNDS = { minWidth: 100, minHeight: 80, maxWidth: 1000, maxHeight: 800 };

describe("resizeDims", () => {
  it("grows by the drag delta within bounds", () => {
    expect(resizeDims(200, 150, 50, 30, BOUNDS)).toEqual({ width: 250, height: 180 });
  });

  it("clamps down to the minimum size", () => {
    expect(resizeDims(200, 150, -300, -300, BOUNDS)).toEqual({ width: 100, height: 80 });
  });

  it("clamps up to the (viewport-derived) maximum size", () => {
    expect(resizeDims(200, 150, 5000, 5000, { ...BOUNDS, maxWidth: 400, maxHeight: 300 })).toEqual({
      width: 400,
      height: 300,
    });
  });

  it("floors max at min so a too-small viewport can't invert the range", () => {
    expect(
      resizeDims(200, 150, 0, 0, { minWidth: 300, minHeight: 200, maxWidth: 100, maxHeight: 50 }),
    ).toEqual({ width: 300, height: 200 });
  });
});
