import { describe, expect, it } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { computeField } from "./field.ts";

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
