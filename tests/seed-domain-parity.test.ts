import { displayTraceSteps, traceFields } from "@compute";
import { worldHalfExtentForGrid } from "@containers";
import { dipoleStep, syntheticStep } from "@data/readers/synthetic.ts";
import { interpolatorFromDataset } from "@numerics/interp.ts";
import { traceFieldLinesAdaptive } from "@numerics/tracing.ts";
import type { Vec3 } from "@schema/types.ts";
import { defaultSeedRake, seedFromSlice, seedFromVolume } from "@store";
import { describe, expect, it } from "vitest";

// Cross-layer guard: a picked seed (store/seedPick, world → physical grid coords) must land
// inside the tracer's interpolator domain and actually trace. This is the load-bearing −0.5
// cell-centered invariant checked against the REAL numerics/interp + numerics/tracing — a store-layer
// unit test can't import numerics (DAG), so it lives here (top-level tests/ is exempt). If seedPick's
// world→grid map drifts from interp's physical→index map, these break instead of traces silently
// diverging from pypic.

const DATASET = syntheticStep(16, 0, 1); // cubic flux rope, origin 0 / spacing 1, nonzero guide field
const HALF = worldHalfExtentForGrid(DATASET.grid);

// A spread of cursor rays that all strike the centered box from outside (down each axis + an oblique).
const RAYS: ReadonlyArray<{ origin: Vec3; dir: Vec3 }> = [
  { origin: [2, 0, 0], dir: [-1, 0, 0] },
  { origin: [0, 2, 0], dir: [0, -1, 0] },
  { origin: [0, 0, 2], dir: [0, 0, -1] },
  { origin: [1, 1, 1], dir: [-1, -1, -1] },
];

function inDomain(seed: Vec3): boolean {
  const interp = interpolatorFromDataset(DATASET);
  return interp.sample(Float64Array.from(seed), new Float64Array(3));
}

describe("seed picking → interpolator domain", () => {
  it("every volume-box seed lands inside the interpolator domain", () => {
    for (const { origin, dir } of RAYS) {
      for (const depth of ["entry", "midpoint"] as const) {
        const seed = seedFromVolume(origin, dir, DATASET.grid, HALF, depth);
        expect(seed, `${depth} seed for ray ${origin}`).not.toBeNull();
        if (seed !== null) expect(inDomain(seed), `${depth} seed ${seed} in domain`).toBe(true);
      }
    }
  });

  it("every slice-plane seed lands inside the interpolator domain (incl. the box-face position)", () => {
    for (const axis of ["x", "y", "z"] as const) {
      for (const position of [0, 0.5, 1]) {
        // A ray down the held axis always meets that slice plane at the box center of the free axes.
        const dir: Vec3 = axis === "x" ? [-1, 0, 0] : axis === "y" ? [0, -1, 0] : [0, 0, -1];
        const origin: Vec3 = [-2 * dir[0], -2 * dir[1], -2 * dir[2]];
        const seed = seedFromSlice(origin, dir, axis, position, DATASET.grid, HALF);
        expect(seed, `${axis}@${position}`).not.toBeNull();
        if (seed !== null) expect(inDomain(seed), `${axis}@${position} seed ${seed}`).toBe(true);
      }
    }
  });

  it("honors a non-zero origin/spacing grid against the real interpolator (dipole)", () => {
    const dipole = dipoleStep();
    const half = worldHalfExtentForGrid(dipole.grid);
    const seed = seedFromVolume([2, 0, 0], [-1, 0, 0], dipole.grid, half, "midpoint");
    expect(seed).not.toBeNull();
    if (seed !== null) {
      const out = new Float64Array(3);
      expect(interpolatorFromDataset(dipole).sample(Float64Array.from(seed), out)).toBe(true);
    }
  });
});

describe("seed picking → tracer", () => {
  it("a center-of-volume seed traces to a field line (≥ 2 points)", () => {
    const seed = seedFromVolume([2, 0, 0], [-1, 0, 0], DATASET.grid, HALF, "midpoint");
    expect(seed).not.toBeNull();
    if (seed === null) return;
    const [line] = traceFieldLinesAdaptive(DATASET, [seed], { direction: "both" });
    expect(line).toBeDefined();
    expect(line?.nPoints).toBeGreaterThanOrEqual(2);
  });

  it("a slice seed on the box face traces without throwing (clamp closes the validateSeed gap)", () => {
    // position 0 is the box face — pre-clamp it would map to physical = origin, which the tracer's
    // up-front validateSeed rejects as out-of-domain. clampSeedToDomain pulls it to the first cell.
    const seed = seedFromSlice([0, 0, 2], [0, 0, -1], "z", 0, DATASET.grid, HALF);
    expect(seed).not.toBeNull();
    if (seed === null) return;
    expect(() => traceFieldLinesAdaptive(DATASET, [seed])).not.toThrow();
  });
});

// Issue #1: the dipole's default rake drops one seed inside the zeroed r < 1.1 R_E interior. Before
// the per-seed skip that single null took the whole layer's traces with it and the layer rendered
// empty. Cross-layer because it needs the real dipole (data) + rake (store) + tracer (compute).
describe("default rake → dipole (issue #1)", () => {
  const dipole = dipoleStep();

  it("traces every seed outside the inner cutoff and reports the one that is inside", async () => {
    const seeds = defaultSeedRake(dipole.grid);
    const { lines, skipped } = await traceFields(dipole, seeds, {
      direction: "both",
      ...displayTraceSteps(dipole.grid),
    });
    expect(seeds).toHaveLength(8);
    expect(lines).toHaveLength(7);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe("field_null");
    // The rake runs along x at y = z = 0; only the seed inside r < 1.1 R_E is a null.
    expect(Math.hypot(...(skipped[0]?.seed ?? [9, 9, 9]))).toBeLessThan(1.1);
    for (const line of lines) expect(line.fieldName).toBe("B");
  });

  it("resolves the lines finely enough to read as curves, not polygons", async () => {
    const steps = displayTraceSteps(dipole.grid);
    const { lines } = await traceFields(dipole, defaultSeedRake(dipole.grid), {
      direction: "both",
      ...steps,
    });
    // No segment longer than the display step — that, not a point count, is the smoothness the
    // renderer needs (a short line near the cutoff legitimately has few points).
    for (const line of lines) {
      for (let p = 1; p < line.nPoints; p++) {
        const a = (p - 1) * 3;
        const b = p * 3;
        const segment = Math.hypot(
          (line.points[b] ?? 0) - (line.points[a] ?? 0),
          (line.points[b + 1] ?? 0) - (line.points[a + 1] ?? 0),
          (line.points[b + 2] ?? 0) - (line.points[a + 2] ?? 0),
        );
        expect(segment).toBeLessThanOrEqual(steps.maxStep * (1 + 1e-9));
      }
    }
    // pypic's max_step of 2.0 gave 3–13 points per line on this 15x10x10 R_E domain.
    expect(Math.max(...lines.map((line) => line.nPoints))).toBeGreaterThan(40);
  });

  it("closes every line on the inner cutoff — the dipole's own null region", async () => {
    const { lines } = await traceFields(dipole, defaultSeedRake(dipole.grid), {
      direction: "both",
      ...displayTraceSteps(dipole.grid),
    });
    for (const line of lines) expect(line.reason).toBe("null_point");
  });
});
