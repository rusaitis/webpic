import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { dummyGrid, fieldArray, makeDataset } from "../../tests/fixtures.ts";
import { displayTraceSteps, traceFields, vectorComponentsForField } from "./traceField.ts";

// A 4³ uniform B = (0,0,1): a seed at a cell center (domain spans [0.5, 3.5]) traces a straight
// z-line of ≥2 points — enough to exercise the async facade end-to-end.
const traceable = () => {
  const n = 4;
  const size = n * n * n;
  return makeDataset(
    {
      B_1: fieldArray("B_1", new Float64Array(size), [n, n, n]),
      B_2: fieldArray("B_2", new Float64Array(size), [n, n, n]),
      B_3: fieldArray("B_3", new Float64Array(size).fill(1), [n, n, n]),
    },
    { grid: dummyGrid([n, n, n]) },
  );
};

// The same 4³ grid with a null slab at x-index 1: a seed there is at |B| = 0 and can't start a trace.
const withNullSlab = () => {
  const n = 4;
  const size = n * n * n;
  const b3 = new Float64Array(size).fill(1);
  for (let iy = 0; iy < n; iy++) for (let iz = 0; iz < n; iz++) b3[iz + n * (iy + n * 1)] = 0;
  return makeDataset(
    {
      B_1: fieldArray("B_1", new Float64Array(size), [n, n, n]),
      B_2: fieldArray("B_2", new Float64Array(size), [n, n, n]),
      B_3: fieldArray("B_3", b3, [n, n, n]),
    },
    { grid: dummyGrid([n, n, n]) },
  );
};

const seeds: readonly Vec3[] = [[2, 2, 2]];

describe("traceFields facade", () => {
  it("resolves to one FieldLine per seed for a valid trace", async () => {
    const { lines, skipped } = await traceFields(traceable(), seeds, { direction: "both" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.nPoints).toBeGreaterThanOrEqual(2);
    expect(skipped).toHaveLength(0);
  });

  it("skips a seed at a field null and still traces the rest (issue #1)", async () => {
    const rake: readonly Vec3[] = [
      [2, 2, 2],
      [1.5, 2, 2], // inside the zeroed slab
      [3, 2, 2],
    ];
    const { lines, skipped } = await traceFields(withNullSlab(), rake, { direction: "both" });
    expect(lines).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.index).toBe(1);
    expect(skipped[0]?.reason).toBe("field_null");
  });

  it("skips a seed outside the domain, keeping the in-domain ones", async () => {
    const rake: readonly Vec3[] = [
      [2, 2, 2],
      [100, 2, 2],
    ];
    const { lines, skipped } = await traceFields(traceable(), rake, { direction: "both" });
    expect(lines).toHaveLength(1);
    expect(skipped[0]?.reason).toBe("outside_domain");
  });

  it("drops a seed whose trace fails mid-flight, keeping the healthy ones", async () => {
    // A z axis two cells deep (domain [0.2, 0.6]): the first DP stage steps out both ways, so the
    // seed validates but yields a 1-point line — which is no line at all.
    const dims = [4, 4, 2];
    const size = 4 * 4 * 2;
    const thin = makeDataset(
      {
        B_1: fieldArray("B_1", new Float64Array(size), dims),
        B_2: fieldArray("B_2", new Float64Array(size), dims),
        B_3: fieldArray("B_3", new Float64Array(size).fill(1), dims),
      },
      { grid: { ...dummyGrid(dims), spacing: [1, 1, 0.4] } },
    );
    const { lines, skipped } = await traceFields(
      thin,
      [
        [2, 2, 0.4],
        [3, 3, 0.4],
      ],
      { direction: "both" },
    );
    expect(lines).toHaveLength(0);
    expect(skipped.map((s) => s.reason)).toEqual(["trace_failed", "trace_failed"]);
    expect(skipped.map((s) => s.index)).toEqual([0, 1]);
  });

  it("names the traced vector even when nothing traced", async () => {
    const { lines, fieldName } = await traceFields(traceable(), [[100, 100, 100]]);
    expect(lines).toHaveLength(0);
    expect(fieldName).toBe("B");
  });

  it('onInvalidSeed: "throw" restores the strict pypic batch contract', async () => {
    const rake: readonly Vec3[] = [
      [2, 2, 2],
      [1.5, 2, 2],
    ];
    await expect(
      traceFields(withNullSlab(), rake, { direction: "both", onInvalidSeed: "throw" }),
    ).rejects.toThrow(/field null/);
  });

  it("rejects with AbortError when the signal is already aborted", async () => {
    const error = await traceFields(
      traceable(),
      seeds,
      { direction: "both" },
      AbortSignal.abort(),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError"); // assert name — message differs Node vs browser
  });
});

describe("vectorComponentsForField", () => {
  const dataset = traceable();

  it("resolves a magnitude to its stored components", () => {
    expect(vectorComponentsForField("|B|", dataset)).toEqual(["B_1", "B_2", "B_3"]);
  });

  it("resolves a bare component to its own family", () => {
    expect(vectorComponentsForField("B_2", dataset)).toEqual(["B_1", "B_2", "B_3"]);
  });

  it("resolves a perpendicular magnitude to the unprojected family it stores", () => {
    const withE = makeDataset({
      E_1: fieldArray("E_1", new Float64Array(64), [4, 4, 4]),
      E_2: fieldArray("E_2", new Float64Array(64), [4, 4, 4]),
      E_3: fieldArray("E_3", new Float64Array(64), [4, 4, 4]),
    });
    expect(vectorComponentsForField("|E_perp|", withE)).toEqual(["E_1", "E_2", "E_3"]);
  });

  it("returns null for a scalar and for a vector the dataset doesn't carry", () => {
    expect(vectorComponentsForField("beta", dataset)).toBeNull();
    expect(vectorComponentsForField("|E|", dataset)).toBeNull();
  });
});

describe("displayTraceSteps", () => {
  it("refines the pypic default on a small domain and never coarsens it", () => {
    const dipole = displayTraceSteps({
      ...dummyGrid([150, 100, 100]),
      spacing: [0.1, 0.1, 0.1],
      origin: [-10, -5, -5],
    });
    expect(dipole.maxStep).toBeCloseTo(0.02 * Math.sqrt(15 ** 2 + 10 ** 2 + 10 ** 2), 6);
    // The first step is taken before the controller clamps, so it comes down with maxStep.
    expect(dipole.stepSizeInit).toBe(dipole.maxStep);
    const big = displayTraceSteps(dummyGrid([256, 256, 256]));
    expect(big.maxStep).toBe(2.0); // capped at pypic's max_step
    expect(big.stepSizeInit).toBe(0.5); // pypic's default, untouched
  });
});
