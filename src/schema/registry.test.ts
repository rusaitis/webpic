import { describe, expect, it } from "vitest";
import { fieldInfo, isCanonicalFieldName, resolveFieldMeta } from "./registry.ts";

describe("resolveFieldMeta", () => {
  it("resolves base canonical names", () => {
    expect(isCanonicalFieldName("B_1")).toBe(true);
    expect(isCanonicalFieldName("rho_c")).toBe(true);
    expect(resolveFieldMeta("B_1")?.quantityType).toBe("b_field");
  });

  it("resolves per-species components by stripping the _sN infix", () => {
    expect(isCanonicalFieldName("n_s0")).toBe(true); // direct registry hit
    expect(isCanonicalFieldName("V_s0_1")).toBe(true); // base V_1
    expect(isCanonicalFieldName("P_s0_11")).toBe(true); // base P_11
  });

  it("rejects coordinates and unknown names", () => {
    expect(isCanonicalFieldName("x")).toBe(false);
    expect(isCanonicalFieldName("weird_thing")).toBe(false);
    expect(resolveFieldMeta("weird_thing")).toBeUndefined();
  });
});

describe("fieldInfo", () => {
  it("resolves every name a reader admits, per-species components included", () => {
    // The zarr reader accepts a field iff isCanonicalFieldName does, so anything it lists reaches
    // the label formatters. fieldInfo used to consult the bare registry and throw on V_s0_1.
    expect(fieldInfo("V_s0_1").quantityType).toBe(resolveFieldMeta("V_1")?.quantityType);
    expect(fieldInfo("|B|").longName).toBeTypeOf("string");
  });

  it("throws on a name the registry cannot resolve, naming the offender", () => {
    expect(() => fieldInfo("weird_thing")).toThrow(/fieldInfo: unknown canonical field name/);
  });
});
