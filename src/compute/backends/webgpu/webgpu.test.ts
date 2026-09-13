import { describe, expect, it } from "vitest";
import type { RecipeMeta } from "../../recipe.ts";
import { RECIPES } from "../../recipes.generated.ts";
import { isWebgpuComputable, webgpuBackend } from "./index.ts";
import { buildKernelParams, PARAMS_BYTE_LENGTH, toFloat32 } from "./params.ts";

// A flag-free recipe stub; override only the fields a case cares about.
function recipe(over: Partial<RecipeMeta>): RecipeMeta {
  return {
    func: "curl",
    fields: ["B_1", "B_2", "B_3"],
    speciesIndex: null,
    needsGrid: false,
    needsGamma: false,
    needsC: false,
    component: null,
    speciesArgs: null,
    passesGeometry: false,
    supportsRelativistic: false,
    ...over,
  };
}

describe("isWebgpuComputable", () => {
  it("accepts the bound magnitude / curl / divergence func names", () => {
    expect(isWebgpuComputable(recipe({ func: "magnetic_field_magnitude" }))).toBe(true);
    expect(isWebgpuComputable(recipe({ func: "electric_field_magnitude" }))).toBe(true);
    expect(isWebgpuComputable(recipe({ func: "current_density_magnitude" }))).toBe(true);
    expect(isWebgpuComputable(recipe({ func: "velocity_magnitude" }))).toBe(true);
    expect(isWebgpuComputable(recipe({ func: "div_b", needsGrid: true }))).toBe(true);
    expect(isWebgpuComputable(recipe({ func: "div_e", needsGrid: true }))).toBe(true);
  });

  // The regression guard: curl recipes carry component:0/1/2 AND needsGrid — the kernel handles both,
  // so (unlike the TS backend) neither may gate them out.
  it("accepts curl despite its component index and grid requirement", () => {
    expect(isWebgpuComputable(recipe({ func: "curl", component: 0, needsGrid: true }))).toBe(true);
    expect(isWebgpuComputable(recipe({ func: "curl", component: 2, needsGrid: true }))).toBe(true);
  });

  it("rejects unbound funcs and gamma / c / species recipes", () => {
    expect(isWebgpuComputable(recipe({ func: "plasma_beta" }))).toBe(false);
    expect(isWebgpuComputable(recipe({ func: "curl", needsGamma: true }))).toBe(false);
    expect(isWebgpuComputable(recipe({ func: "curl", needsC: true }))).toBe(false);
    expect(
      isWebgpuComputable(recipe({ func: "velocity_magnitude", speciesArgs: "mass_only" })),
    ).toBe(false);
  });

  // Tie the gate to the real codegen'd recipes, not just stubs — catches a func-name drift.
  it("accepts the canonical |B| / curl_B_1 / div_B recipes", () => {
    expect(isWebgpuComputable(RECIPES["|B|"])).toBe(true);
    expect(isWebgpuComputable(RECIPES.curl_B_1)).toBe(true);
    expect(isWebgpuComputable(RECIPES.div_B)).toBe(true);
  });

  it("supports() is false without an installed device (Node / worker)", () => {
    // isWebgpuComputable says yes, but no GPU is installed here → the dispatcher must not route to it.
    expect(webgpuBackend.supports(RECIPES.curl_B_1)).toBe(false);
  });
});

describe("buildKernelParams byte layout", () => {
  it("packs dims, inverse spacing, count, and component (little-endian, std430-tight)", () => {
    const params = buildKernelParams([4, 3, 2], [0.5, 1, 4], 1, 24);
    expect(params.byteLength).toBe(PARAMS_BYTE_LENGTH);
    const view = new DataView(params);
    expect(view.getUint32(0, true)).toBe(4);
    expect(view.getUint32(4, true)).toBe(3);
    expect(view.getUint32(8, true)).toBe(2);
    expect(view.getFloat32(12, true)).toBe(2); // 1/0.5
    expect(view.getFloat32(16, true)).toBe(1); // 1/1
    expect(view.getFloat32(20, true)).toBe(0.25); // 1/4
    expect(view.getUint32(24, true)).toBe(24);
    expect(view.getUint32(28, true)).toBe(1);
  });

  it("defaults missing dims/spacing to 1 (magnitude's grid-agnostic path)", () => {
    const view = new DataView(buildKernelParams([5], [], 0, 5));
    expect(view.getUint32(0, true)).toBe(5);
    expect(view.getUint32(4, true)).toBe(1);
    expect(view.getUint32(8, true)).toBe(1);
    expect(view.getFloat32(12, true)).toBe(1);
  });
});

describe("toFloat32 downcast", () => {
  it("passes a Float32Array through by reference (no copy)", () => {
    const f32 = new Float32Array([1, 2, 3]);
    expect(toFloat32(f32)).toBe(f32);
  });

  it("downcasts a Float64Array to a fresh Float32Array", () => {
    const out = toFloat32(new Float64Array([1.5, 2.5, 3.5]));
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([1.5, 2.5, 3.5]);
  });
});
