import type { FloatArray, Vec3 } from "@schema/types.ts";

// The dependency-free core of the smooth analytic field: the definition (shape, spacing, component
// functions) and the row-major sampler. Split out from analyticField.ts — whose smoothVectorField
// pulls makeDataset/makeField (and thus path aliases) — so scripts/gen-fixtures.ts can import it
// under bare `node` (type-only imports erase; no @layer alias resolution needed at runtime). The
// pypic golden harness and both compute backends sample the SAME definition from here.

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
