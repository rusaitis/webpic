import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SMOOTH_COMPONENTS,
  SMOOTH_SHAPE,
  SMOOTH_SPACING,
  sampleScalar,
} from "../tests/analyticFieldCore.ts";

// Generate the pypic golden fixtures consumed by tests/goldens.test.ts (TS backend) and the
// crossBackend.browser golden block (WebGPU backend). For each case we sample the field in f64 here,
// hand those exact arrays to pypic (scripts/pypic_goldens.py), and check the operator outputs in.
// pypic is the numerical authority; passing the same input bytes both backends see isolates the
// comparison to operator arithmetic. Run manually (and re-run after touching the analytic field):
//   npm run gen:fixtures        (needs `uv` + the sibling ../pypic project)
// Plain `node` strips the types but does NOT resolve @layer aliases, so this imports only the
// alias-free analyticFieldCore — never @compute / @containers.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "tests", "fixtures", "v1");

// Mirrors tests/crossBackend.ts CROSS_BACKEND_CASES — the recipes both compute backends bind. The
// node golden test asserts the fixture covers exactly these, so the two lists can't silently drift.
const RECIPES = ["|B|", "div_B", "curl_B_1", "curl_B_2", "curl_B_3"] as const;

interface FixtureCase {
  readonly name: string;
  readonly description: string;
  readonly shape: readonly number[];
  readonly spacing: readonly [number, number, number];
  readonly components: readonly [
    (x: number, y: number, z: number) => number,
    (x: number, y: number, z: number) => number,
    (x: number, y: number, z: number) => number,
  ];
}

// M3.4 seeds the smooth analytic field; M3.5 (gen-synthetic) appends Orszag–Tang / Harris / GEM cases.
const CASES: readonly FixtureCase[] = [
  {
    name: "smooth-field",
    description: "smooth analytic vector field (tests/analyticFieldCore.ts)",
    shape: SMOOTH_SHAPE,
    spacing: SMOOTH_SPACING,
    components: SMOOTH_COMPONENTS,
  },
];

interface GoldenResponse {
  readonly pypicVersion: string;
  readonly goldens: Record<string, number[]>;
}

function runPypic(request: unknown): GoldenResponse {
  const result = spawnSync(
    "uv",
    ["run", "--project", "../pypic", "python", "scripts/pypic_goldens.py"],
    {
      cwd: ROOT,
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 512 * 1024 * 1024, // headroom for M3.5's larger MHD fields
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pypic_goldens.py exited ${result.status}:\n${result.stderr}`);
  }
  // JSON.parse is untyped; the helper's response shape is the GoldenResponse contract above.
  return JSON.parse(result.stdout) as GoldenResponse;
}

function generate(testCase: FixtureCase): void {
  const [fn1, fn2, fn3] = testCase.components;
  const f1 = sampleScalar(testCase.shape, testCase.spacing, fn1, Float64Array);
  const f2 = sampleScalar(testCase.shape, testCase.spacing, fn2, Float64Array);
  const f3 = sampleScalar(testCase.shape, testCase.spacing, fn3, Float64Array);
  const inputs = { B_1: Array.from(f1), B_2: Array.from(f2), B_3: Array.from(f3) };

  const { pypicVersion, goldens } = runPypic({
    shape: [...testCase.shape],
    spacing: [...testCase.spacing],
    components: inputs,
    recipes: [...RECIPES],
  });

  const missing = RECIPES.filter((recipe) => !(recipe in goldens));
  if (missing.length > 0) {
    throw new Error(`pypic returned no golden for: ${missing.join(", ")}`);
  }

  const fixture = {
    provenance: {
      source: "pypic",
      pypicVersion,
      generator: "scripts/gen-fixtures.ts",
      field: testCase.description,
      note: "Goldens from pypic.coordinates/derived (np.gradient edge_order=1). Regenerate: npm run gen:fixtures",
    },
    grid: { shape: [...testCase.shape], spacing: [...testCase.spacing], geometry: "cartesian" },
    inputs,
    goldens,
  };

  const path = join(OUT_DIR, `${testCase.name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`✓ ${testCase.name}: ${RECIPES.length} goldens (pypic ${pypicVersion}) → ${path}`);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const testCase of CASES) generate(testCase);
