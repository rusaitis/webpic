import { describe, expect, it } from "vitest";
import { finiteMin, finiteRange } from "./range.ts";

describe("finiteRange", () => {
  it("skips non-finite samples", () => {
    const range = finiteRange(new Float32Array([Number.NaN, 2, -1, Number.POSITIVE_INFINITY, 5]));
    expect(range).toEqual({ min: -1, max: 5 });
  });
  it("widens a constant field so the window has width", () => {
    expect(finiteRange(new Float64Array([3, 3, 3]))).toEqual({ min: 3, max: 4 });
  });
  it("is null when nothing is finite", () => {
    expect(finiteRange(new Float32Array([Number.NaN, Number.NEGATIVE_INFINITY]))).toBeNull();
    expect(finiteRange(new Float32Array(0))).toBeNull();
  });
});

describe("finiteMin", () => {
  it("matches finiteRange's minimum and is null when nothing is finite", () => {
    const data = new Float32Array([Number.NaN, 7, -2, 4]);
    expect(finiteMin(data)).toBe(finiteRange(data)?.min);
    expect(finiteMin(new Float32Array([Number.NaN]))).toBeNull();
  });
});
