import { describe, expect, it } from "vitest";
import { isSameShape, rowMajorStrides } from "./math.ts";

describe("isSameShape", () => {
  it("accepts equal shapes", () => {
    expect(isSameShape([256, 256, 256], [256, 256, 256])).toBe(true);
  });

  it("rejects a differing extent", () => {
    expect(isSameShape([256, 256, 256], [256, 128, 256])).toBe(false);
  });

  it("rejects a rank mismatch", () => {
    expect(isSameShape([256, 256], [256, 256, 1])).toBe(false);
  });

  it("accepts two empty shapes", () => {
    expect(isSameShape([], [])).toBe(true);
  });
});

describe("rowMajorStrides", () => {
  it("computes C-order strides", () => {
    expect(rowMajorStrides([2, 3, 4])).toEqual([12, 4, 1]);
  });

  it("handles 1-D and empty shapes", () => {
    expect(rowMajorStrides([7])).toEqual([1]);
    expect(rowMajorStrides([])).toEqual([]);
  });
});
