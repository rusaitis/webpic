import { readFileSync } from "node:fs";
import { computeField } from "@compute/field.ts";
import { describe, expect, it } from "vitest";
import {
  gridOf,
  SMOOTH_COMPONENTS,
  SMOOTH_SHAPE,
  SMOOTH_SPACING,
  sampleScalar,
} from "./analyticFieldCore.ts";
import { CROSS_BACKEND_CASES } from "./crossBackend.ts";
import { fieldArray, makeDataset } from "./fixtures.ts";
import { assertAllclose } from "./helpers.ts";
import { type Kernel, TOL } from "./tolerances.ts";

// The TS backend (coordinates/ + derived/) vs the checked-in pypic goldens. pypic is the independent
// numerical authority webpic's operators were ported from; both apply the identical np.gradient
// edge_order=1 stencil, so f64-vs-f64 agreement is machine-precision (TOL.<kernel>.ts_f64) and any
// drift is a real regression. The WebGPU side checks the same goldens at webgpu_f32 in
// src/compute/backends/crossBackend.browser.test.ts (local `npm run test:gpu`). Fixtures are
// checked in by `npm run gen:fixtures`, so this suite needs no pypic at test time.

interface GoldenFixture {
  readonly grid: { readonly shape: readonly number[]; readonly spacing: [number, number, number] };
  readonly inputs: { readonly B_1: number[]; readonly B_2: number[]; readonly B_3: number[] };
  readonly goldens: Record<string, number[]>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/v1/smooth-field.json", import.meta.url), "utf8"),
) as GoldenFixture;

// Recipe → kernel-tolerance bucket. Cross-checked against CROSS_BACKEND_CASES and the fixture below,
// so this list can't silently fall out of sync with what the backends actually bind.
const GOLDEN_CASES: ReadonlyArray<{ readonly recipe: string; readonly kernel: Kernel }> = [
  { recipe: "|B|", kernel: "magnitude" },
  { recipe: "div_B", kernel: "divergence" },
  { recipe: "curl_B_1", kernel: "curl" },
  { recipe: "curl_B_2", kernel: "curl" },
  { recipe: "curl_B_3", kernel: "curl" },
];

const dataset = makeDataset(
  {
    B_1: fieldArray("B_1", Float64Array.from(fixture.inputs.B_1), fixture.grid.shape),
    B_2: fieldArray("B_2", Float64Array.from(fixture.inputs.B_2), fixture.grid.shape),
    B_3: fieldArray("B_3", Float64Array.from(fixture.inputs.B_3), fixture.grid.shape),
  },
  { grid: gridOf(fixture.grid.shape, fixture.grid.spacing) },
);

describe("pypic goldens — TS backend vs checked-in pypic outputs", () => {
  for (const { recipe, kernel } of GOLDEN_CASES) {
    it(`${recipe} matches the pypic golden at ts_f64`, async () => {
      const golden = fixture.goldens[recipe];
      expect(golden, `fixture missing golden for ${recipe}`).toBeDefined();
      if (golden === undefined) return;

      const result = await computeField(recipe, dataset);
      expect(result.shape).toEqual([...fixture.grid.shape]);
      expect(result.data.length).toBe(golden.length);
      assertAllclose(result.data, golden, TOL[kernel].ts_f64);
      // Metadata is packaged (canonical label↔name parity itself is schema-parity.test's job).
      expect(result.units.length).toBeGreaterThan(0);
      expect(result.latex.length).toBeGreaterThan(0);
    });
  }

  it("covers exactly the cross-backend recipe set", () => {
    const golden = Object.keys(fixture.goldens).sort();
    const cases = GOLDEN_CASES.map((c) => c.recipe).sort();
    const crossBackend = CROSS_BACKEND_CASES.map((c) => c.recipe).sort();
    expect(cases).toEqual(golden);
    expect(crossBackend).toEqual(golden);
  });

  it("stored inputs still match the analytic field (regenerate with npm run gen:fixtures if this fails)", () => {
    const [fn1, fn2, fn3] = SMOOTH_COMPONENTS;
    const resample = (fn: (typeof SMOOTH_COMPONENTS)[number]): number[] =>
      Array.from(sampleScalar(SMOOTH_SHAPE, SMOOTH_SPACING, fn, Float64Array));
    expect([...fixture.grid.shape]).toEqual([...SMOOTH_SHAPE]);
    expect(fixture.grid.spacing).toEqual([...SMOOTH_SPACING]);
    expect(fixture.inputs.B_1).toEqual(resample(fn1));
    expect(fixture.inputs.B_2).toEqual(resample(fn2));
    expect(fixture.inputs.B_3).toEqual(resample(fn3));
  });
});
