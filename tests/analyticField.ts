import type { FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import type { FloatArray, Vec3 } from "@schema/types.ts";
import { fieldArray, makeDataset } from "./fixtures.ts";

// A smooth analytic vector field on a Cartesian grid: O(1)-amplitude components with non-trivial,
// well-conditioned curl and divergence everywhere. Shared by the real-GPU parity suite (vs the
// coordinates/derived twins) and the ts-vs-webgpu cross-backend harness, so the fixture lives once.

export type ScalarFn = (x: number, y: number, z: number) => number;

// Distinct dims + anisotropic spacing: every axis hits all three np.gradient stencil branches, and a
// transposed stride or swapped spacing fails loudly rather than aliasing into a near-equal answer.
export const SMOOTH_SHAPE: readonly number[] = [5, 4, 3];
export const SMOOTH_SPACING: Vec3 = [0.5, 1, 2];

export const SMOOTH_COMPONENTS: readonly [ScalarFn, ScalarFn, ScalarFn] = [
  (x, y, z) => Math.sin(0.7 * x) * Math.cos(0.5 * y) + 0.2 * z,
  (x, y, z) => Math.cos(0.4 * x) * Math.sin(0.6 * y) * Math.cos(0.3 * z),
  (x, y, z) => Math.sin(0.3 * x + 0.2 * y) + 0.5 * Math.cos(0.4 * z),
];

type ArrayCtor = Float32ArrayConstructor | Float64ArrayConstructor;

export function gridOf(shape: readonly number[], spacing: Vec3): GridInfo {
  return {
    dimensions: [...shape],
    spacing: [...spacing],
    origin: [0, 0, 0],
    geometry: "cartesian",
    axisLabels: ["x", "y", "z"],
    dt: null,
    boundary: null,
    survivingAxes: null,
    stagger: null,
  };
}

// Sample fn over the row-major grid at physical coordinates index*spacing (origin 0). f32 by default
// (the GPU storage precision); pass Float64Array for the TS reference path.
export function sampleScalar(
  shape: readonly number[],
  spacing: Vec3,
  fn: ScalarFn,
  ArrayType: ArrayCtor = Float32Array,
): FloatArray {
  const nx = shape[0] ?? 1;
  const ny = shape[1] ?? 1;
  const nz = shape[2] ?? 1;
  const out = new ArrayType(nx * ny * nz);
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        out[(ix * ny + iy) * nz + iz] = fn(ix * spacing[0], iy * spacing[1], iz * spacing[2]);
      }
    }
  }
  return out;
}

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
