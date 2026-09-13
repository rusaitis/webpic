import { describe, expect, it } from "vitest";
import { smoothVectorField } from "../../tests/analyticField.ts";
import { makeDataset, makeField, makeGrid, vectorTriple } from "../../tests/fixtures.ts";
import { isTsComputable } from "./backends/ts/index.ts";
import { isWebgpuComputable } from "./backends/webgpu/index.ts";
import { computableFields, computeField } from "./field.ts";
import type { RecipeMeta } from "./recipe.ts";
import { RECIPES } from "./recipes.generated.ts";

describe("computeField", () => {
  it("computes |B| via the canonical recipe registry", async () => {
    const out = await computeField("|B|", vectorTriple("B"));
    expect(Array.from(out.data)).toEqual([5]); // sqrt(3^2 + 4^2)
    expect(out.meta.siUnit).toBe("T");
  });

  it("rejects an unknown recipe name loudly", () => {
    expect(() => computeField("not-a-recipe", vectorTriple("B"))).toThrow(/unknown recipe/);
  });

  it("rejects a grid op on a reduced dataset at the dispatcher, not inside the operator", () => {
    // A z-integrated pypic dataset: rank 3, but one sample on the collapsed axis. The failure must
    // name computeField and the grid — partialAlongAxis' message would mean the gate leaked.
    const flat: readonly number[] = [8, 8, 1];
    const component = (name: string) => makeField(name, new Float64Array(64), flat);
    const reduced = makeDataset(
      { B_1: component("B_1"), B_2: component("B_2"), B_3: component("B_3") },
      { grid: makeGrid(flat) },
    );
    expect(computableFields(reduced)).toEqual(["|B|"]); // the selector hides it...
    expect(() => computeField("div_B", reduced)).toThrow(
      /computeField: recipe "div_B" needs a 3-D cartesian grid with ≥2 samples per axis, got cartesian \[8, 8, 1\]/,
    ); // ...and the dispatcher refuses it
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

// The two backends bind the same func names by design — computableFields is the union over
// BACKENDS.supports, so a kernel added to one and forgotten in the other does not fail anywhere:
// the recipe just keeps working on one backend and silently degrades on the other.
describe("isTsComputable ≡ isWebgpuComputable", () => {
  const computableBy = (supports: (recipe: RecipeMeta) => boolean): string[] =>
    Object.values(RECIPES)
      .filter(supports)
      .map((recipe) => recipe.func)
      .sort();

  it("binds the same op set on both backends", () => {
    expect(computableBy(isTsComputable)).toEqual(computableBy(isWebgpuComputable));
  });

  it("binds an op only for a func some recipe actually names", () => {
    const bound = new Set(computableBy(isTsComputable));
    expect(bound.size).toBeGreaterThan(0);
    for (const func of bound) {
      expect(Object.values(RECIPES).some((recipe) => recipe.func === func)).toBe(true);
    }
  });
});
