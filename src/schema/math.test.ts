import { describe, expect, it } from "vitest";
import { sameShape } from "./math.ts";

describe("sameShape", () => {
  it("accepts equal shapes", () => {
    expect(sameShape([256, 256, 256], [256, 256, 256])).toBe(true);
  });

  it("rejects a differing extent", () => {
    expect(sameShape([256, 256, 256], [256, 128, 256])).toBe(false);
  });

  it("rejects a rank mismatch", () => {
    expect(sameShape([256, 256], [256, 256, 1])).toBe(false);
  });

  it("accepts two empty shapes", () => {
    expect(sameShape([], [])).toBe(true);
  });
});
