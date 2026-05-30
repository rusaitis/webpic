import { RECIPES } from "@compute";
import {
  COMPUTE_ALIASES,
  FIELD_REGISTRY,
  fieldInfo,
  SimulationSchema,
  SPECIES_SUFFIX_RE,
} from "@schema";
import { describe, expect, it } from "vitest";

describe("generated recipes", () => {
  it("maps a magnitude to its components", () => {
    expect(RECIPES["|B|"].fields).toEqual(["B_1", "B_2", "B_3"]);
  });

  it("carries recipe metadata flags", () => {
    expect(RECIPES.v_A.fields).toEqual(["|B|", "rho_m"]);
    expect(RECIPES.v_A.supportsRelativistic).toBe(true);
  });
});

describe("generated aliases", () => {
  it("resolves descriptive names to canonical", () => {
    expect(COMPUTE_ALIASES.plasma_beta).toBe("beta");
  });

  it("matches per-species canonical names, not plain components", () => {
    expect(SPECIES_SUFFIX_RE.test("|V_s0|")).toBe(true);
    expect(SPECIES_SUFFIX_RE.test("P_s1")).toBe(true);
    expect(SPECIES_SUFFIX_RE.test("B_1")).toBe(false);
  });
});

describe("generated field registry", () => {
  it("exposes canonical units", () => {
    expect(FIELD_REGISTRY["|B|"]?.siUnit).toBe("T");
    expect(fieldInfo("|B|").siUnit).toBe("T");
  });

  it("rejects unknown field names loudly", () => {
    expect(() => fieldInfo("not_a_field")).toThrow(/Unknown field name/);
  });
});

describe("generated Zod validators", () => {
  it("rejects an object missing required sections", () => {
    expect(SimulationSchema.safeParse({}).success).toBe(false);
  });
});
