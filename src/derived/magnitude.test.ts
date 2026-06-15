import { describe, expect, it } from "vitest";
import { assertAllclose } from "../../tests/helpers.ts";
import { TOL } from "../../tests/tolerances.ts";
import {
  currentDensityMagnitude,
  electricFieldMagnitude,
  magneticFieldMagnitude,
  vectorMagnitude,
  velocityMagnitude,
} from "./magnitude.ts";

describe("vectorMagnitude", () => {
  it("satisfies the 3-4-5 Pythagorean identity", () => {
    const out = vectorMagnitude(
      new Float64Array([3]),
      new Float64Array([4]),
      new Float64Array([0]),
    );
    assertAllclose(out, [5]);
  });

  it("computes a 1-2-2 → 3 triple and a zero vector", () => {
    const out = vectorMagnitude(
      new Float64Array([1, 0]),
      new Float64Array([2, 0]),
      new Float64Array([2, 0]),
    );
    assertAllclose(out, [3, 0]);
  });

  it("computes elementwise over a multi-point field", () => {
    const out = vectorMagnitude(
      new Float64Array([3, 5, 8]),
      new Float64Array([4, 12, 15]),
      new Float64Array([0, 0, 0]),
    );
    assertAllclose(out, [5, 13, 17], TOL.ts_f64);
  });

  it("computes at render (f32) precision", () => {
    const out = vectorMagnitude(
      new Float32Array([3, 5, 8]),
      new Float32Array([4, 12, 15]),
      new Float32Array([0, 0, 0]),
    );
    assertAllclose(out, [5, 13, 17], TOL.ts_f32);
  });

  it("returns f32 for f32 inputs and f64 for f64 inputs", () => {
    expect(
      vectorMagnitude(new Float32Array([3]), new Float32Array([4]), new Float32Array([0])),
    ).toBeInstanceOf(Float32Array);
    expect(
      vectorMagnitude(new Float64Array([3]), new Float32Array([4]), new Float32Array([0])),
    ).toBeInstanceOf(Float64Array);
  });

  it("throws on a component length mismatch", () => {
    expect(() =>
      vectorMagnitude(new Float64Array([1, 2]), new Float64Array([1]), new Float64Array([1, 2])),
    ).toThrow(/length mismatch/);
  });
});

describe("magnitude family", () => {
  // Mirrors pypic's MAGNITUDE_FUNCTIONS parametrized test: every |X| = sqrt(X1²+X2²+X3²).
  const family: ReadonlyArray<
    [string, (a: Float64Array, b: Float64Array, c: Float64Array) => Float32Array | Float64Array]
  > = [
    ["|B|", magneticFieldMagnitude],
    ["|E|", electricFieldMagnitude],
    ["|J|", currentDensityMagnitude],
    ["|V|", velocityMagnitude],
  ];

  for (const [label, fn] of family) {
    it(`${label}: (3,4,0) → 5`, () => {
      assertAllclose(fn(new Float64Array([3]), new Float64Array([4]), new Float64Array([0])), [5]);
    });
  }
});
