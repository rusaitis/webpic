import type { FieldDataset } from "@containers/field_dataset.ts";
import { vec3 } from "@schema/math.ts";
import { describe, expect, it } from "vitest";
import { makeDataset, makeField, makeGrid } from "../../tests/fixtures.ts";
import { TOL } from "../../tests/tolerances.ts";
import { interpolatorFromDataset, type VectorFieldInterpolator } from "./interp.ts";
import {
  classifySeed,
  makeFieldLine,
  partitionSeeds,
  type TerminationReason,
  traceFieldLineAdaptive,
  traceFieldLinesAdaptive,
} from "./tracing.ts";

// Analytical fixtures. The bounds below are DP5(4) method properties (truncation), not the backend
// precision gap tests/tolerances.ts grades — the one exception is the transverse drift, which is a
// pure f64 round-off claim and reads the ladder's trace reference floor. Fields are sampled
// CELL-CENTERED — sample i at origin + (i+0.5)·dx — the interpolator's pypic-compatible convention.

// A seed re-crossing: "both" stitches two half-traces, so the join must coincide with the seed to
// well within one integration step (steps here are O(0.1) grid units).
const SEED_COINCIDENCE = 1e-9;

type ScalarFn = (x: number, y: number, z: number) => number;
type Vec3 = readonly [number, number, number];

function sampleCellCentered(shape: Vec3, spacing: Vec3, origin: Vec3, fn: ScalarFn): Float64Array {
  const [nx, ny, nz] = shape;
  const out = new Float64Array(nx * ny * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const x = origin[0] + (i + 0.5) * spacing[0];
        const y = origin[1] + (j + 0.5) * spacing[1];
        const z = origin[2] + (k + 0.5) * spacing[2];
        out[(i * ny + j) * nz + k] = fn(x, y, z);
      }
    }
  }
  return out;
}

function vectorDataset(
  shape: Vec3,
  spacing: Vec3,
  fns: readonly [ScalarFn, ScalarFn, ScalarFn],
  origin: Vec3 = [0, 0, 0],
): FieldDataset {
  const grid = makeGrid(shape, spacing, origin);
  return makeDataset(
    {
      B_1: makeField("B_1", sampleCellCentered(shape, spacing, origin, fns[0]), shape),
      B_2: makeField("B_2", sampleCellCentered(shape, spacing, origin, fns[1]), shape),
      B_3: makeField("B_3", sampleCellCentered(shape, spacing, origin, fns[2]), shape),
    },
    { grid },
  );
}

const ZERO: ScalarFn = () => 0;
const ONE: ScalarFn = () => 1;

function pointAt(points: Float64Array, i: number): Vec3 {
  return [
    points[3 * i] ?? Number.NaN,
    points[3 * i + 1] ?? Number.NaN,
    points[3 * i + 2] ?? Number.NaN,
  ];
}

// 8³ unit grid, uniform +x field — cell centers span [0.5, 7.5]; the pypic doctest grid.
const uniform = vectorDataset([8, 8, 8], [1, 1, 1], [ONE, ZERO, ZERO]);

describe("traceFieldLineAdaptive — uniform field", () => {
  it("traces an exact straight line (transverse components stay at the seed)", () => {
    const fl = traceFieldLineAdaptive(uniform, [4, 4, 4], { direction: "forward" });
    expect(fl.nPoints).toBeGreaterThanOrEqual(2);
    expect(fl.reason).toBe<TerminationReason>("domain_exit"); // marches off +x
    expect(pointAt(fl.points, 0)).toEqual([4, 4, 4]);
    for (let i = 0; i < fl.nPoints; i++) {
      const [x, y, z] = pointAt(fl.points, i);
      expect(Math.abs(y - 4)).toBeLessThan(TOL.trace.ts_f64.atol);
      expect(Math.abs(z - 4)).toBeLessThan(TOL.trace.ts_f64.atol);
      if (i > 0) expect(x).toBeGreaterThan(pointAt(fl.points, i - 1)[0]); // strictly advancing +x
    }
  });

  it('stitches "both" directions through the seed exactly once', () => {
    const fl = traceFieldLineAdaptive(uniform, [4, 4, 4], { direction: "both" });
    expect(fl.direction).toBe("both");
    expect(fl.seedPoint).toEqual([4, 4, 4]);
    // Strictly increasing x ⇒ the shared seed is not duplicated at the join.
    for (let i = 1; i < fl.nPoints; i++) {
      expect(pointAt(fl.points, i)[0]).toBeGreaterThan(pointAt(fl.points, i - 1)[0]);
    }
    const seedHits = Array.from({ length: fl.nPoints }, (_, i) => pointAt(fl.points, i)).filter(
      ([x, y, z]) =>
        Math.abs(x - 4) < SEED_COINCIDENCE &&
        Math.abs(y - 4) < SEED_COINCIDENCE &&
        Math.abs(z - 4) < SEED_COINCIDENCE,
    );
    expect(seedHits).toHaveLength(1);
  });

  it("stops at max_steps when it can neither exit nor close", () => {
    const fl = traceFieldLineAdaptive(uniform, [4, 4, 4], {
      direction: "forward",
      maxSteps: 2,
      maxStep: 0.1,
    });
    expect(fl.reason).toBe<TerminationReason>("max_steps");
    expect(fl.nPoints).toBe(3); // seed + 2 accepted steps
    expect(fl.metadata.nSteps).toBe(2);
  });

  it("stops on a terminate() callback", () => {
    const fl = traceFieldLineAdaptive(uniform, [4, 4, 4], {
      direction: "forward",
      terminate: (p) => (p[0] ?? 0) > 6,
    });
    expect(fl.reason).toBe<TerminationReason>("callback");
    expect(pointAt(fl.points, fl.nPoints - 1)[0]).toBeGreaterThan(6);
  });
});

describe("traceFieldLineAdaptive — termination on field structure", () => {
  it("closes a loop in a rotational field", () => {
    // B = (-(y-16), (x-16), 0): field lines are circles about the grid centre (16, 16).
    const rot = vectorDataset([32, 32, 3], [1, 1, 1], [(_x, y) => -(y - 16), (x) => x - 16, ZERO]);
    const fl = traceFieldLineAdaptive(rot, [24, 16, 1.5], { direction: "forward" });
    expect(fl.reason).toBe<TerminationReason>("closed_loop");
    // Stays on the radius-8 circle: every point is ≈8 from the centre.
    for (let i = 0; i < fl.nPoints; i++) {
      const [x, y] = pointAt(fl.points, i);
      expect(Math.hypot(x - 16, y - 16)).toBeCloseTo(8, 2);
    }
  });

  it("stops at a field null", () => {
    // B = (x-6, 0, 0): a null plane at x = 6. A small max step lands inside the null band.
    const sheet = vectorDataset([12, 3, 3], [1, 1, 1], [(x) => x - 6, ZERO, ZERO]);
    const fl = traceFieldLineAdaptive(sheet, [9, 1.5, 1.5], {
      direction: "backward",
      maxStep: 0.05,
      nullThreshold: 0.1,
    });
    expect(fl.reason).toBe<TerminationReason>("null_point");
    // "backward" reverses at assembly: the seed is last, the null-terminated end is index 0.
    expect(pointAt(fl.points, fl.nPoints - 1)).toEqual([9, 1.5, 1.5]);
    expect(pointAt(fl.points, 0)[0]).toBeCloseTo(6, 0); // stopped in the |x−6| < 0.1 null band
  });
});

describe("traceFieldLineAdaptive — seed validation", () => {
  it("throws on an out-of-domain seed", () => {
    expect(() => traceFieldLineAdaptive(uniform, [100, 4, 4])).toThrow(
      /outside the interpolation domain/,
    );
  });

  it("throws on a seed at a field null", () => {
    const sheet = vectorDataset([12, 3, 3], [1, 1, 1], [(x) => x - 6, ZERO, ZERO]);
    expect(() => traceFieldLineAdaptive(sheet, [6, 1.5, 1.5])).toThrow(/field null/);
  });
});

describe("classifySeed / partitionSeeds", () => {
  const sheet = () => vectorDataset([12, 3, 3], [1, 1, 1], [(x) => x - 6, ZERO, ZERO]);

  it("names why a seed can't start a trace, without throwing", () => {
    const interp = interpolatorFromDataset(sheet());
    expect(classifySeed(interp, Float64Array.from([2, 1.5, 1.5]), 1e-12)).toBeNull();
    expect(classifySeed(interp, Float64Array.from([6, 1.5, 1.5]), 1e-12)).toBe("field_null");
    expect(classifySeed(interp, Float64Array.from([100, 1.5, 1.5]), 1e-12)).toBe("outside_domain");
  });

  it("splits a rake, keeping original indices and order", () => {
    const interp = interpolatorFromDataset(sheet());
    const seeds = [
      [2, 1.5, 1.5],
      [6, 1.5, 1.5], // the null sheet
      [9, 1.5, 1.5],
      [100, 1.5, 1.5], // outside
    ].map((s) => Float64Array.from(s));
    const { traceable, skipped } = partitionSeeds(interp, seeds, 1e-12);
    expect(traceable.map((t) => [t.index, t.seed[0]])).toEqual([
      [0, 2],
      [2, 9],
    ]);
    expect(skipped.map((s) => [s.index, s.reason])).toEqual([
      [1, "field_null"],
      [3, "outside_domain"],
    ]);
  });
});

describe("traceFieldLinesAdaptive — multi-seed", () => {
  it("returns one line per seed", () => {
    const lines = traceFieldLinesAdaptive(uniform, [
      [2, 4, 4],
      [5, 4, 4],
    ]);
    expect(lines).toHaveLength(2);
    for (const fl of lines) expect(fl.metadata.method).toBe("rk45_dopri");
  });

  it("validates every seed up front (one bad seed throws before any tracing)", () => {
    expect(() =>
      traceFieldLinesAdaptive(uniform, [
        [4, 4, 4],
        [100, 4, 4],
      ]),
    ).toThrow(/outside the interpolation domain/);
  });
});

describe("makeFieldLine invariants", () => {
  const base = {
    fieldName: "B",
    seedPoint: vec3(0, 0, 0),
    normalization: uniform.normalization,
    direction: "forward" as const,
    reason: "max_steps" as const,
    atol: 1e-6,
    rtol: 1e-3,
    maxLocalError: 0,
  };

  it("rejects fewer than 2 points", () => {
    expect(() => makeFieldLine({ ...base, points: new Float64Array([1, 2, 3]) })).toThrow(
      /≥ 2 points/,
    );
  });

  it("rejects a points length that is not a multiple of 3", () => {
    expect(() => makeFieldLine({ ...base, points: new Float64Array([1, 2, 3, 4]) })).toThrow(
      /multiple of 3/,
    );
  });

  it("rejects a scalar whose length disagrees with the point count", () => {
    expect(() =>
      makeFieldLine({
        ...base,
        points: new Float64Array([0, 0, 0, 1, 0, 0]),
        scalars: new Map([["foo", new Float64Array([1, 2, 3])]]),
      }),
    ).toThrow(/makeFieldLine: scalar foo needs 2 samples, got 3/);
  });
});

describe("pypic doctest fidelity", () => {
  it("trace_field_line_adaptive metadata (forward, max_steps=4)", () => {
    const fl = traceFieldLineAdaptive(uniform, [4, 4, 4], { direction: "forward", maxSteps: 4 });
    expect(fl.metadata.method).toBe("rk45_dopri");
    expect(Number.isFinite(fl.metadata.maxLocalError)).toBe(true);
    expect(pointAt(fl.points, fl.nPoints - 1)[0]).toBeGreaterThan(pointAt(fl.points, 0)[0]);
  });

  it("trace_field_lines_adaptive returns one rk45_dopri line per seed", () => {
    const lines = traceFieldLinesAdaptive(uniform, [
      [2, 2, 2],
      [4, 4, 4],
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.every((fl) => fl.metadata.method === "rk45_dopri")).toBe(true);
  });
});

describe("cancellation (AbortSignal)", () => {
  const expectAbortError = (error: unknown): void => {
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError"); // assert name — message differs Node vs browser
  };

  it("throws AbortError when the signal is already aborted, before any tracing", () => {
    let error: unknown;
    try {
      traceFieldLineAdaptive(uniform, [4, 4, 4], { direction: "forward" }, AbortSignal.abort());
    } catch (e) {
      error = e;
    }
    expectAbortError(error);
  });

  it("interrupts mid-integration — the per-step check fires once the signal aborts", () => {
    const base = interpolatorFromDataset(uniform, ["B_1", "B_2", "B_3"]);
    const controller = new AbortController();
    let calls = 0;
    // Abort on the first sample after seed validation (call #1) — i.e. during the first integration
    // step — so the next top-of-loop throwIfAborted fires well before the natural domain exit.
    const wrapped: VectorFieldInterpolator = {
      sample(point, out) {
        if (++calls === 2) controller.abort();
        return base.sample(point, out);
      },
    };
    let error: unknown;
    try {
      traceFieldLineAdaptive(
        uniform,
        [4, 4, 4],
        { direction: "forward", interpolator: wrapped },
        controller.signal,
      );
    } catch (e) {
      error = e;
    }
    expectAbortError(error);
    expect(calls).toBeGreaterThan(1); // proves it got past validation into the loop, then aborted
  });

  it("traceFieldLinesAdaptive rejects an already-aborted signal before tracing any seed", () => {
    let error: unknown;
    try {
      traceFieldLinesAdaptive(
        uniform,
        [
          [2, 2, 2],
          [4, 4, 4],
        ],
        {},
        AbortSignal.abort(),
      );
    } catch (e) {
      error = e;
    }
    expectAbortError(error);
  });
});
