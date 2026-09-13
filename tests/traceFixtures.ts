import type { FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import type { AdaptiveTraceOptions } from "@numerics/tracing.ts";
import rotationalJson from "./fixtures/traces/rotational.json";
import smoothJson from "./fixtures/traces/smooth.json";
import uniformJson from "./fixtures/traces/uniform.json";
import { makeDataset, makeField, makeGrid } from "./fixtures.ts";

// Shared loader for the checked-in pypic golden traces (tests/fixtures/traces/*.json). The node golden
// test and the GPU browser parity test both rebuild the dataset through this one path, so the two can't
// drift in how they reconstruct the field from JSON. Static JSON imports (not node:fs) so it loads in the
// browser test environment too — mirrors crossBackend.browser.test.ts.

export interface GoldenTrace {
  readonly points: readonly number[];
  readonly nPoints: number;
  readonly reason: string;
  readonly nSteps: number;
  readonly maxLocalError: number;
  readonly method: string;
}

export interface TraceFixture {
  readonly grid: {
    readonly dimensions: [number, number, number];
    readonly spacing: [number, number, number];
    readonly origin: [number, number, number];
    readonly geometry: string;
  };
  readonly seeds: ReadonlyArray<[number, number, number]>;
  readonly options: AdaptiveTraceOptions;
  readonly inputs: { readonly B_1: number[]; readonly B_2: number[]; readonly B_3: number[] };
  readonly traces: readonly GoldenTrace[];
}

// Vite types a JSON import structurally; assert the fixture contract through unknown.
export const TRACE_FIXTURES = {
  uniform: uniformJson as unknown as TraceFixture,
  smooth: smoothJson as unknown as TraceFixture,
  rotational: rotationalJson as unknown as TraceFixture,
} as const;

export type TraceFixtureName = keyof typeof TRACE_FIXTURES;

/** Rebuild the f64 `FieldDataset` (B_1/B_2/B_3 on a cell-centered cartesian grid) from a fixture. */
export function datasetFromFixture(fix: TraceFixture): FieldDataset {
  const shape = fix.grid.dimensions;
  const grid: GridInfo = makeGrid(shape, fix.grid.spacing, fix.grid.origin);
  return makeDataset(
    {
      B_1: makeField("B_1", Float64Array.from(fix.inputs.B_1), shape),
      B_2: makeField("B_2", Float64Array.from(fix.inputs.B_2), shape),
      B_3: makeField("B_3", Float64Array.from(fix.inputs.B_3), shape),
    },
    { grid },
  );
}
