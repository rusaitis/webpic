import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOOTH_COMPONENTS, sampleCellCentered } from "../tests/analyticFieldCore.ts";
import { runPypic } from "./harness/pypic.ts";

// Generate the pypic golden field-line traces consumed by tests/traces.golden.test.ts. For each
// fixture we sample the field CELL-CENTERED in f64 here (sample i at origin + (i+0.5)·dx — the
// pypic grid convention the interpolator mirrors), hand those exact arrays to pypic
// (scripts/pypic_trace_goldens.py), and store the traces it integrates. Passing the same input bytes
// both sides interpolate isolates the comparison to the DP5(4) + trilinear arithmetic. Run manually
// (and re-run after touching a fixture field):
//   npm run gen:trace-fixtures        (needs `uv` + the sibling ../pypic project)
// Plain `node` strips types but does NOT resolve @layer aliases, so this imports only the alias-free
// analyticFieldCore — never @numerics / @containers.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "tests", "fixtures", "traces");

type ScalarFn = (x: number, y: number, z: number) => number;
type Vec3 = [number, number, number];

interface TraceFixture {
  readonly name: string;
  readonly description: string;
  readonly shape: Vec3;
  readonly spacing: Vec3;
  readonly origin: Vec3;
  readonly components: readonly [ScalarFn, ScalarFn, ScalarFn];
  readonly seeds: readonly Vec3[];
  readonly options: Readonly<Record<string, unknown>>; // camelCase AdaptiveTraceOptions subset
}

const ZERO: ScalarFn = () => 0;

const FIXTURES: readonly TraceFixture[] = [
  {
    name: "uniform",
    description: "uniform +x field on an 8³ unit grid — DP5(4) is exact, so parity is bit-tight",
    shape: [8, 8, 8],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    components: [() => 1, ZERO, ZERO],
    seeds: [[4, 4, 4]],
    options: { direction: "both" },
  },
  {
    name: "smooth",
    description:
      "smooth analytic vector field (tests/analyticFieldCore.ts) — non-trivial trilinear",
    shape: [16, 16, 16],
    spacing: [0.5, 0.5, 0.5],
    origin: [0, 0, 0],
    components: SMOOTH_COMPONENTS,
    seeds: [[4, 4, 4]],
    // Small maxStep ⇒ many trilinear-interpolated steps (a richer parity exercise) while errNorm
    // stays far below 1, so the accept/reject sequence is identical on both sides (no ULP flip).
    options: { direction: "forward", maxStep: 0.25, maxSteps: 200 },
  },
  {
    name: "rotational",
    description: "B = (-(y-16), (x-16), 0): circular field lines about (16,16) — closed-loop gate",
    shape: [32, 32, 3],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    components: [(_x, y) => -(y - 16), (x) => x - 16, ZERO],
    seeds: [[24, 16, 1.5]],
    options: { direction: "forward" },
  },
];

interface GoldenTrace {
  readonly points: number[];
  readonly nPoints: number;
  readonly reason: string;
  readonly nSteps: number;
  readonly maxLocalError: number;
  readonly method: string;
}

interface GoldenResponse {
  readonly pypicVersion: string;
  readonly traces: readonly GoldenTrace[];
}

function generate(fix: TraceFixture): void {
  const [f1, f2, f3] = fix.components;
  const inputs = {
    B_1: Array.from(sampleCellCentered(fix.shape, fix.spacing, fix.origin, f1)),
    B_2: Array.from(sampleCellCentered(fix.shape, fix.spacing, fix.origin, f2)),
    B_3: Array.from(sampleCellCentered(fix.shape, fix.spacing, fix.origin, f3)),
  };
  const grid = { dimensions: fix.shape, spacing: fix.spacing, origin: fix.origin };

  const { pypicVersion, traces } = runPypic<GoldenResponse>(
    ["python", "scripts/pypic_trace_goldens.py"],
    {
      grid,
      components: inputs,
      seeds: fix.seeds.map((s) => [...s]),
      options: fix.options,
    },
  );

  const fixture = {
    provenance: {
      source: "pypic",
      pypicVersion,
      generator: "scripts/gen-trace-fixtures.ts",
      field: fix.description,
      note: "Cell-centered f64 inputs; goldens from pypic.traces.trace_field_line_adaptive. Regenerate: npm run gen:trace-fixtures",
    },
    grid: { ...grid, geometry: "cartesian" },
    seeds: fix.seeds.map((s) => [...s]),
    options: fix.options,
    inputs,
    traces,
  };

  const path = join(OUT_DIR, `${fix.name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  const reasons = traces.map((t) => `${t.reason}/${t.nPoints}pts`).join(", ");
  console.log(
    `✓ ${fix.name}: ${traces.length} trace(s) [${reasons}] (pypic ${pypicVersion}) → ${path}`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });
for (const fix of FIXTURES) generate(fix);
