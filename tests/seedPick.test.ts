import { dipoleStep, syntheticStep } from "@data/readers/synthetic.ts";
import { interpolatorFromDataset } from "@numerics/interp.ts";
import { traceFieldLinesAdaptive } from "@numerics/tracing.ts";
import type { Vec3 } from "@schema/types.ts";
import { seedFromSlice, seedFromVolume, worldHalfExtentForGrid } from "@store";
import { describe, expect, it } from "vitest";

// Cross-layer guard for M4.4: a picked seed (store/seedPick, world → physical grid coords) must land
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
