import { describe, expect, it } from "vitest";
import { fieldArray, makeDataset, vectorTriple } from "../../tests/fixtures.ts";
import { computableFields, computeField } from "./field.ts";

describe("computeField", () => {
  it("computes |B| via the canonical recipe registry", () => {
    const out = computeField("|B|", vectorTriple("B"));
    expect(Array.from(out.data)).toEqual([5]); // sqrt(3^2 + 4^2)
    expect(out.meta.siUnit).toBe("T");
  });

  it("rejects an unknown recipe name loudly", () => {
    expect(() => computeField("not-a-recipe", vectorTriple("B"))).toThrow(/unknown recipe/);
  });
});

describe("computableFields", () => {
  it("offers only TS-computable recipes whose inputs are present", () => {
    // B-only: the magnitude recipe computes; curl/div/psi need ops the TS backend lacks.
    expect(computableFields(vectorTriple("B"))).toEqual(["|B|"]);
  });

  it("grows as more input components are present", () => {
    const triple = (prefix: string) => ({
      [`${prefix}_1`]: fieldArray(`${prefix}_1`, new Float32Array([3]), [1]),
      [`${prefix}_2`]: fieldArray(`${prefix}_2`, new Float32Array([4]), [1]),
      [`${prefix}_3`]: fieldArray(`${prefix}_3`, new Float32Array([0]), [1]),
    });
    expect(
      computableFields(makeDataset({ ...triple("B"), ...triple("E"), ...triple("J") })),
    ).toEqual(["|B|", "|E|", "|J|"]);
  });

  it("returns nothing when no recipe's inputs are satisfiable", () => {
    expect(computableFields(makeDataset({}))).toEqual([]);
  });
});
