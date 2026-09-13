import { describe, expect, it } from "vitest";
import { cssRgba } from "./theme.ts";

describe("cssRgba", () => {
  it("formats rgba-0..1 as a CSS rgba() string", () => {
    expect(cssRgba([1, 0.5, 0, 0.8])).toBe("rgba(255, 128, 0, 0.8)");
  });
});
