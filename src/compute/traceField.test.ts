import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { dummyGrid, fieldArray, makeDataset } from "../../tests/fixtures.ts";
import { traceFields } from "./traceField.ts";

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

const seeds: readonly Vec3[] = [[2, 2, 2]];

describe("traceFields facade", () => {
  it("resolves to one FieldLine per seed for a valid trace", async () => {
    const lines = await traceFields(traceable(), seeds, { direction: "both" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.nPoints).toBeGreaterThanOrEqual(2);
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
