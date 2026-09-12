import { describe, expect, it } from "vitest";
import { smoothVectorField } from "../../tests/analyticField.ts";
import { makeDataset, makeField, vectorTriple } from "../../tests/fixtures.ts";
import { computableFields, computeField } from "./field.ts";

describe("computeField", () => {
  it("computes |B| via the canonical recipe registry", async () => {
    const out = await computeField("|B|", vectorTriple("B"));
    expect(Array.from(out.data)).toEqual([5]); // sqrt(3^2 + 4^2)
    expect(out.meta.siUnit).toBe("T");
  });

  it("rejects an unknown recipe name loudly", () => {
    expect(() => computeField("not-a-recipe", vectorTriple("B"))).toThrow(/unknown recipe/);
  });
});

describe("computableFields", () => {
  it("offers only TS-computable recipes whose inputs are present", () => {
    // B-only on a 1-cell grid: |B| computes; curl/div need a 3-D grid (this fixture is 1-D), so the
    // grid guard keeps them out even though the TS backend now binds the ops.
    expect(computableFields(vectorTriple("B"))).toEqual(["|B|"]);
  });

  it("offers curl/divergence once the grid is 3-D", () => {
    // Same B components, but a real 5×4×3 Cartesian grid: the grid ops the TS backend now binds become
    // selectable alongside the magnitude.
    expect(computableFields(smoothVectorField().dataset)).toEqual([
      "curl_B_1",
      "curl_B_2",
      "curl_B_3",
      "div_B",
      "|B|",
    ]);
  });

  it("grows as more input components are present", () => {
    const triple = (prefix: string) => ({
      [`${prefix}_1`]: makeField(`${prefix}_1`, new Float32Array([3]), [1]),
      [`${prefix}_2`]: makeField(`${prefix}_2`, new Float32Array([4]), [1]),
      [`${prefix}_3`]: makeField(`${prefix}_3`, new Float32Array([0]), [1]),
    });
    expect(
      computableFields(makeDataset({ ...triple("B"), ...triple("E"), ...triple("J") })),
    ).toEqual(["|B|", "|E|", "|J|"]);
  });

  it("returns nothing when no recipe's inputs are satisfiable", () => {
    expect(computableFields(makeDataset({}))).toEqual([]);
  });
});
