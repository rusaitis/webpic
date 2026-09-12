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
  it("computes sqrt(x²+y²+z²) elementwise, including the zero vector", () => {
    const out = vectorMagnitude(
      new Float64Array([3, 5, 8, 1, 0]),
      new Float64Array([4, 12, 15, 2, 0]),
      new Float64Array([0, 0, 0, 2, 0]),
    );
    assertAllclose(out, [5, 13, 17, 3, 0], TOL.magnitude.ts_f64);
  });

  it("computes at render (f32) precision", () => {
    const out = vectorMagnitude(
      new Float32Array([3, 5, 8]),
      new Float32Array([4, 12, 15]),
      new Float32Array([0, 0, 0]),
    );
    assertAllclose(out, [5, 13, 17], TOL.magnitude.ts_f32);
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

// The per-field aliases are re-run through computeRecipeTs in compute/backends/ts/magnitude.test.ts,
// which additionally proves the recipe wiring; here we only pin that each alias exists and delegates.
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
      assertAllclose(
        fn(new Float64Array([3]), new Float64Array([4]), new Float64Array([0])),
        [5],
        TOL.magnitude.ts_f64,
      );
    });
  }
});
