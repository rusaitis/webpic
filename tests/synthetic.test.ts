import { readFileSync } from "node:fs";
import { computeField } from "@compute/field.ts";
import { describe, expect, it } from "vitest";
import { gridOf, type ScalarFn, sampleScalar } from "./analyticFieldCore.ts";
import { fieldArray, makeDataset } from "./fixtures.ts";
import { assertAllclose } from "./helpers.ts";
import {
  SYNTHETIC_FIELDS,
  type SyntheticField,
  type SyntheticRecipe,
  spacingFor,
} from "./syntheticFieldsCore.ts";
import { type Kernel, TOL } from "./tolerances.ts";

// The TS backend (coordinates/ + derived/) vs the closed-form analytic answers of three divergence-free
// MHD configurations (Orszag–Tang, Harris, GEM). No pypic: the fields ARE the oracle (DESIGN §Testing).
// Two regimes, both honest:
//   • Exact identities — where no quantity actually varies along the differencing axis, the FD result
//     equals the analytic answer to machine precision: div=0 and the two zero curl components for every
//     field, and |B| (a pointwise magnitude, never differenced). Checked at TOL.<kernel>.ts_f64.
//   • Convergence — where the perturbation varies along the differencing axis (the nonzero curl current,
//     and GEM's divergence), the FD result equals the analytic answer only to truncation. Validated by a
//     2nd-order convergence test (halving h cuts the interior error ~4×) rather than a magic tolerance.
// np.gradient is first-order one-sided at the boundary planes, so the 2nd-order rate is measured on the
// interior (≥1 cell cropped per face). The WebGPU twin runs in crossBackend.browser (local test:gpu).

interface SyntheticFixture {
  readonly grid: { readonly shape: readonly number[]; readonly spacing: [number, number, number] };
  readonly inputs: { readonly B_1: number[]; readonly B_2: number[]; readonly B_3: number[] };
  readonly analytic: Record<string, number[]>;
}

const FIXTURES = new Map<string, SyntheticFixture>(
  SYNTHETIC_FIELDS.map((field) => [
    field.name,
    JSON.parse(
      readFileSync(new URL(`./fixtures/synthetic/${field.name}.json`, import.meta.url), "utf8"),
    ) as SyntheticFixture,
  ]),
);

const RECIPES: readonly SyntheticRecipe[] = ["|B|", "div_B", "curl_B_1", "curl_B_2", "curl_B_3"];

const KERNEL_OF: Record<SyntheticRecipe, Kernel> = {
  "|B|": "magnitude",
  div_B: "divergence",
  curl_B_1: "curl",
  curl_B_2: "curl",
  curl_B_3: "curl",
};

// Recipes whose FD result matches the analytic answer only to truncation → convergence-tested, not
// exact. `base` resolutions sit well inside the asymptotic regime so the error ratio lands near 4; the
// sheet center is a grid point at both base and 2× so the curl_3 peak is sampled consistently.
const CONVERGENCE: Record<
  string,
  { readonly base: readonly [number, number, number]; readonly recipes: readonly SyntheticRecipe[] }
> = {
  "orszag-tang": { base: [32, 32, 4], recipes: ["curl_B_3"] },
  harris: { base: [16, 40, 4], recipes: ["curl_B_3"] },
  gem: { base: [40, 40, 4], recipes: ["div_B", "curl_B_3"] },
};

const PLANS = SYNTHETIC_FIELDS.map((field) => {
  const conv = CONVERGENCE[field.name];
  const fixture = FIXTURES.get(field.name);
  if (!conv || !fixture)
    throw new Error(`synthetic.test: missing config/fixture for ${field.name}`);
  const convergent = conv.recipes;
  const exact = RECIPES.filter((recipe) => !convergent.includes(recipe));
  return { field, base: conv.base, convergent, exact, fixture };
});

function datasetAt(field: SyntheticField, shape: readonly number[]) {
  const spacing = spacingFor(field, shape);
  const [b1, b2, b3] = field.components;
  return makeDataset(
    {
      B_1: fieldArray("B_1", sampleScalar(shape, spacing, b1, Float64Array), shape),
      B_2: fieldArray("B_2", sampleScalar(shape, spacing, b2, Float64Array), shape),
      B_3: fieldArray("B_3", sampleScalar(shape, spacing, b3, Float64Array), shape),
    },
    { grid: gridOf(shape, spacing) },
  );
}

// Refine in-plane only: the fields are z-invariant, so ∂/∂z is exactly 0 and h_z carries no error.
const refine = (base: readonly [number, number, number]): [number, number, number] => [
  base[0] * 2,
  base[1] * 2,
  base[2],
];

// Max |FD − analytic| over the interior (one cell cropped per face, where np.gradient drops to first
// order). The interior is pure second-order central differences, so this error scales as h².
async function interiorMaxError(
  field: SyntheticField,
  shape: readonly [number, number, number],
  recipe: SyntheticRecipe,
): Promise<number> {
  const spacing = spacingFor(field, shape);
  const result = await computeField(recipe, datasetAt(field, shape));
  const analytic = sampleScalar(shape, spacing, field.analytic[recipe], Float64Array);
  const [nx, ny, nz] = shape;
  let maxErr = 0;
  for (let ix = 1; ix < nx - 1; ix++) {
    for (let iy = 1; iy < ny - 1; iy++) {
      for (let iz = 1; iz < nz - 1; iz++) {
        const idx = (ix * ny + iy) * nz + iz;
        const err = Math.abs((result.data[idx] ?? Number.NaN) - (analytic[idx] ?? Number.NaN));
        if (err > maxErr) maxErr = err;
      }
    }
  }
  return maxErr;
}

describe("synthetic MHD fields — TS backend vs closed-form analytic", () => {
  for (const { field, base, convergent, exact, fixture } of PLANS) {
    describe(field.name, () => {
      for (const recipe of exact) {
        it(`${recipe} matches the analytic field to machine precision`, async () => {
          const golden = fixture.analytic[recipe];
          expect(golden, `fixture missing analytic ${recipe}`).toBeDefined();
          if (!golden) return;
          const result = await computeField(recipe, datasetAt(field, field.shape));
          expect(result.shape).toEqual([...field.shape]);
          expect(result.data.length).toBe(golden.length);
          assertAllclose(result.data, golden, TOL[KERNEL_OF[recipe]].ts_f64);
        });
      }

      for (const recipe of convergent) {
        it(`${recipe} converges at ~2nd order toward the analytic current`, async () => {
          const errBase = await interiorMaxError(field, base, recipe);
          const errFine = await interiorMaxError(field, refine(base), recipe);
          expect(
            errBase,
            "expected a real truncation error at the base resolution",
          ).toBeGreaterThan(0);
          expect(errFine).toBeGreaterThan(0);
          const ratio = errBase / errFine;
          // 2nd order ⇒ halving h cuts the error ~4×; ratio ≥ 3.5 ⇒ observed order ≥ ~1.8 (rules out
          // a first-order ratio of ~2, which would flag a boundary leak or a convention mismatch).
          expect(
            ratio,
            `${recipe}: halving h should cut the error ~4× (got ${ratio.toFixed(2)}: ${errBase.toExponential(2)} → ${errFine.toExponential(2)})`,
          ).toBeGreaterThanOrEqual(3.5);
        });
      }
    });
  }
});

describe("synthetic fixtures match the closed form (regenerate with npm run gen:synthetic)", () => {
  // Compare against the JSON-canonical form of a fresh sample — exactly the bytes regeneration writes.
  // The round-trip preserves every finite f64 but normalizes −0 → 0 (which −sin(0), 0·cos<0, … produce
  // in memory), matching how the stored fixture was serialized, so this catches real value drift only.
  const canon = (values: number[]): number[] => JSON.parse(JSON.stringify(values)) as number[];
  for (const { field, fixture } of PLANS) {
    it(`${field.name}: stored inputs + analytic goldens still match`, () => {
      const spacing = spacingFor(field, field.shape);
      const resample = (fn: ScalarFn): number[] =>
        canon(Array.from(sampleScalar(field.shape, spacing, fn, Float64Array)));
      expect([...fixture.grid.shape]).toEqual([...field.shape]);
      expect(fixture.grid.spacing).toEqual([...spacing]);
      const [b1, b2, b3] = field.components;
      expect(fixture.inputs.B_1).toEqual(resample(b1));
      expect(fixture.inputs.B_2).toEqual(resample(b2));
      expect(fixture.inputs.B_3).toEqual(resample(b3));
      for (const recipe of RECIPES) {
        expect(fixture.analytic[recipe], `analytic ${recipe}`).toEqual(
          resample(field.analytic[recipe]),
        );
      }
    });
  }
});
