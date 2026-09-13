import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleScalar } from "../tests/analyticFieldCore.ts";
import {
  SYNTHETIC_FIELDS,
  SYNTHETIC_RECIPES,
  type SyntheticField,
  spacingFor,
} from "../tests/syntheticFieldsCore.ts";

// Generate the analytical MHD fixtures (Orszag–Tang, Harris, GEM) consumed by tests/synthetic.test.ts.
// Unlike gen-fixtures.ts these need NO pypic: the fields are divergence-free by construction with
// closed-form curl/divergence/magnitude (tests/syntheticFieldsCore.ts), so the goldens are the analytic
// formulas sampled here, not a numeric oracle (DESIGN §Testing — "no pypic dep"). Re-run after touching
// the field definitions:
//   npm run gen:synthetic        (plain node — no `uv`, no ../pypic)
// node strips the types but does NOT resolve @layer aliases, so this imports only the alias-free cores.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "tests", "fixtures", "synthetic");

function generate(field: SyntheticField): void {
  const spacing = spacingFor(field, field.shape);
  const sample = (fn: (x: number, y: number, z: number) => number): number[] =>
    Array.from(sampleScalar(field.shape, spacing, fn, Float64Array));

  const [b1, b2, b3] = field.components;
  const inputs = { B_1: sample(b1), B_2: sample(b2), B_3: sample(b3) };
  const analytic = Object.fromEntries(
    SYNTHETIC_RECIPES.map((recipe) => [recipe, sample(field.analytic[recipe])]),
  );

  const fixture = {
    provenance: {
      source: "analytic",
      generator: "scripts/gen-synthetic.ts",
      field: field.description,
      note: "Divergence-free MHD config; goldens are the closed-form curl/div/|B| (no pypic). Regenerate: npm run gen:synthetic",
    },
    grid: {
      shape: [...field.shape],
      spacing: [...spacing],
      domain: [...field.domain],
      geometry: "cartesian",
    },
    params: field.params,
    inputs,
    analytic,
  };

  const path = join(OUT_DIR, `${field.name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`✓ ${field.name}: ${SYNTHETIC_RECIPES.length} analytic goldens → ${path}`);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const field of SYNTHETIC_FIELDS) generate(field);
