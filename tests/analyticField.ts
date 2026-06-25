import type { FieldDataset } from "@containers/field_dataset.ts";
import type { FloatArray, Vec3 } from "@schema/types.ts";
import {
  gridOf,
  SMOOTH_COMPONENTS,
  SMOOTH_SHAPE,
  SMOOTH_SPACING,
  sampleScalar,
} from "./analyticFieldCore.ts";
import { fieldArray, makeDataset } from "./fixtures.ts";

// A smooth analytic vector field on a Cartesian grid: O(1)-amplitude components with non-trivial,
// well-conditioned curl and divergence everywhere. Shared by the real-GPU parity suite (vs the
// coordinates/derived twins), the ts-vs-webgpu cross-backend harness, and the pypic golden harness,
// so the fixture lives once. The definition + sampler live in analyticFieldCore.ts (alias-free, so
// scripts/gen-fixtures.ts can import them under bare `node`); this file packs them into a FieldDataset.

export type { ScalarFn } from "./analyticFieldCore.ts";
export { gridOf, SMOOTH_COMPONENTS, SMOOTH_SHAPE, SMOOTH_SPACING, sampleScalar };

type ArrayCtor = Float32ArrayConstructor | Float64ArrayConstructor;

export interface SmoothVectorField {
  readonly shape: readonly number[];
  readonly spacing: Vec3;
  readonly f1: FloatArray;
  readonly f2: FloatArray;
  readonly f3: FloatArray;
  readonly dataset: FieldDataset;
}

// The smooth field packed as B_1/B_2/B_3 on a Cartesian grid, plus the raw component arrays the parity
// suite needs for its coordinates twins. f32 by default — fed to both backends so the only gap is
// f32-vs-f64 arithmetic, not input-rounding skew; f64 for the Node reference-plumbing test.
export function smoothVectorField(
  opts: { shape?: readonly number[]; spacing?: Vec3; array?: ArrayCtor } = {},
): SmoothVectorField {
  const shape = opts.shape ?? SMOOTH_SHAPE;
  const spacing = opts.spacing ?? SMOOTH_SPACING;
  const ArrayType = opts.array ?? Float32Array;
  const [fn1, fn2, fn3] = SMOOTH_COMPONENTS;
  const f1 = sampleScalar(shape, spacing, fn1, ArrayType);
  const f2 = sampleScalar(shape, spacing, fn2, ArrayType);
  const f3 = sampleScalar(shape, spacing, fn3, ArrayType);
  const dataset = makeDataset(
    {
      B_1: fieldArray("B_1", f1, shape),
      B_2: fieldArray("B_2", f2, shape),
      B_3: fieldArray("B_3", f3, shape),
    },
    { grid: gridOf(shape, spacing) },
  );
  return { shape, spacing, f1, f2, f3, dataset };
}

export function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] ?? 0));
  return m;
}

export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}
