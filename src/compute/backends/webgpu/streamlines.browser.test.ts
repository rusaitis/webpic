// Real-WebGPU parity for the streamline kernel: it closes the GPU≡CPU≡pypic triangle for field-line
// traces (the trace analog of parity.browser.test.ts for the field ops). The GPU tracer must reproduce
// both the CPU reference (`traceFieldLineAdaptive` — the f32-vs-f64 equivalence bar) and the checked-in
// pypic goldens. Runs only under the gpu project (`WEBPIC_GPU=1`, headed Chrome); skipped green where
// WebGPU is absent.
//
// Measured on Apple M2: the f32 accept/reject flip risk (a GPU f32 errNorm straddling 1.0 where the f64
// reference didn't, after which step COUNTS diverge though the curve does not) did NOT fire — all three
// fixtures hold nPoints/nSteps exactly. So the counts are asserted as the flip canary; if a future driver
// flips a step, relax that fixture's count check (the count-independent Hausdorff / radius checks still
// pin the curve). Tolerances are ~20–40× the measured f32-vs-f64 gap.

import { hasDevice, installGpu } from "@gpu/device.ts";
import { traceFieldLineAdaptive } from "@numerics/tracing.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertAllclose } from "../../../../tests/helpers.ts";
import {
  datasetFromFixture,
  TRACE_FIXTURES,
  type TraceFixture,
} from "../../../../tests/traceFixtures.ts";
import { traceFieldLinesWebgpu } from "./streamlines.ts";

const hasRealGpu = typeof navigator !== "undefined" && "gpu" in navigator;

let installed = false;
let dispose: (() => void) | undefined;

beforeAll(async () => {
  if (!hasRealGpu || hasDevice()) return; // a sibling suite may already hold the singleton
  const handle = await installGpu();
  dispose = handle.dispose;
  installed = true;
});

afterAll(() => {
  if (installed) dispose?.();
});

// Curve-distance helpers — count-independent, so a step-count flip can't fail them.

function pointToSegment(
  p: readonly [number, number, number],
  a: ArrayLike<number>,
  ai: number,
  b: ArrayLike<number>,
  bi: number,
): number {
  const abx = (b[bi] ?? 0) - (a[ai] ?? 0);
  const aby = (b[bi + 1] ?? 0) - (a[ai + 1] ?? 0);
  const abz = (b[bi + 2] ?? 0) - (a[ai + 2] ?? 0);
  const apx = p[0] - (a[ai] ?? 0);
  const apy = p[1] - (a[ai + 1] ?? 0);
  const apz = p[2] - (a[ai + 2] ?? 0);
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 0 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(
    p[0] - ((a[ai] ?? 0) + t * abx),
    p[1] - ((a[ai + 1] ?? 0) + t * aby),
    p[2] - ((a[ai + 2] ?? 0) + t * abz),
  );
}

/** Max over points of `from` of the distance to the `to` polyline; one-directional. */
function directedDistance(
  from: ArrayLike<number>,
  nFrom: number,
  to: ArrayLike<number>,
  nTo: number,
): number {
  let worst = 0;
  for (let i = 0; i < nFrom; i++) {
    const p: readonly [number, number, number] = [
      from[3 * i] ?? 0,
      from[3 * i + 1] ?? 0,
      from[3 * i + 2] ?? 0,
    ];
    let nearest = Number.POSITIVE_INFINITY;
    for (let j = 0; j < nTo - 1; j++) {
      const d = pointToSegment(p, to, 3 * j, to, 3 * (j + 1));
      if (d < nearest) nearest = d;
    }
    if (nearest > worst) worst = nearest;
  }
  return worst;
}

function hausdorff(a: ArrayLike<number>, na: number, b: ArrayLike<number>, nb: number): number {
  return Math.max(directedDistance(a, na, b, nb), directedDistance(b, nb, a, na));
}

const seedsOf = (fix: TraceFixture): ReadonlyArray<readonly number[]> => fix.seeds;

describe("webgpu streamline parity vs the CPU tracer + pypic goldens", () => {
  it.skipIf(!hasRealGpu)("uniform: exact counts + points (flip-free constant field)", async () => {
    const fix = TRACE_FIXTURES.uniform;
    const data = datasetFromFixture(fix);
    const golden = fix.traces[0];
    if (golden === undefined) throw new Error("uniform: missing golden");
    const [gpu] = await traceFieldLinesWebgpu(data, seedsOf(fix), fix.options);
    if (gpu === undefined) throw new Error("uniform: no GPU line");

    expect(gpu.reason).toBe(golden.reason);
    expect(gpu.nPoints).toBe(golden.nPoints);
    expect(gpu.metadata.nSteps).toBe(golden.nSteps);
    // Measured max |Δ| ≈ 2.4e-7 (f32 epsilon scale); the f64 CPU/golden are bit-exact. CPU↔golden is
    // pinned in traces.golden.test.ts, so GPU↔golden here closes the triangle.
    assertAllclose(gpu.points, golden.points, { rtol: 1e-5, atol: 1e-5 });
  });

  it.skipIf(!hasRealGpu)("smooth: GPU matches the CPU twin + golden curve", async () => {
    const fix = TRACE_FIXTURES.smooth;
    const data = datasetFromFixture(fix);
    const golden = fix.traces[0];
    const seed = fix.seeds[0];
    if (golden === undefined || seed === undefined) throw new Error("smooth: missing fixture row");
    const [gpu] = await traceFieldLinesWebgpu(data, seedsOf(fix), fix.options);
    if (gpu === undefined) throw new Error("smooth: no GPU line");
    const cpu = traceFieldLineAdaptive(data, seed, { ...fix.options });

    expect(gpu.reason).toBe(golden.reason);
    expect(gpu.nPoints).toBe(golden.nPoints); // canary: no f32 flip (measured)
    expect(gpu.metadata.nSteps).toBe(golden.nSteps);
    // Count-independent (survives an f32 accept/reject flip): the GPU curve hugs the CPU twin and the
    // pypic golden. Measured Hausdorff ≈ 5e-7 (f32-vs-f64 over a 16-point trace).
    expect(hausdorff(gpu.points, gpu.nPoints, cpu.points, cpu.nPoints)).toBeLessThan(1e-5);
    expect(hausdorff(gpu.points, gpu.nPoints, golden.points, golden.nPoints)).toBeLessThan(1e-5);
  });

  it.skipIf(!hasRealGpu)("rotational: closes the loop on the analytic circle", async () => {
    const fix = TRACE_FIXTURES.rotational;
    const data = datasetFromFixture(fix);
    const golden = fix.traces[0];
    const seed = fix.seeds[0];
    if (golden === undefined || seed === undefined)
      throw new Error("rotational: missing fixture row");
    const [gpu] = await traceFieldLinesWebgpu(data, seedsOf(fix), fix.options);
    if (gpu === undefined) throw new Error("rotational: no GPU line");
    const cpu = traceFieldLineAdaptive(data, seed, { ...fix.options });

    expect(gpu.reason).toBe("closed_loop");
    expect(gpu.reason).toBe(golden.reason);
    expect(gpu.nPoints).toBe(golden.nPoints); // canary: no f32 flip (measured)

    // Analytic invariant: B = (−(y−16), (x−16), 0) → field lines are circles about (16, 16). Every GPU
    // point stays on the seed's circle (radius = |seed − centre|). Measured worst |Δr| ≈ 2.6e-6.
    const cx = 16;
    const cy = 16;
    const radius = Math.hypot((seed[0] ?? 0) - cx, (seed[1] ?? 0) - cy);
    for (let i = 0; i < gpu.nPoints; i++) {
      const r = Math.hypot((gpu.points[3 * i] ?? 0) - cx, (gpu.points[3 * i + 1] ?? 0) - cy);
      expect(Math.abs(r - radius)).toBeLessThan(1e-4);
    }
    // GPU hugs the CPU twin (f32-vs-f64) over the whole loop.
    expect(hausdorff(gpu.points, gpu.nPoints, cpu.points, cpu.nPoints)).toBeLessThan(1e-4);
  });
});
