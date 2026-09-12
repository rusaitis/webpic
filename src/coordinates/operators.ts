// Discrete differential operators on structured Cartesian grids — the TS reference impl the compute
// backends are tested against (cross-backend parity compares the WGSL kernel to this, never a
// duplicate). Second-order central differences in the interior, first-order one-sided at the edges
// (np.gradient's edge_order=1 convention). Mirrors pypic.coordinates.operators: row-major
// (nx, ny, nz), axes 0/1/2 = x/y/z, Cartesian only. Pure leaf — typed arrays in/out, no THREE/DOM/GPU.

import type { GeometryType } from "@containers/field_dataset.ts";
import type { FloatArray, Vec3 } from "@schema/types.ts";
import {
  require3dScalar,
  require3dVector,
  requireCartesian,
  requirePositiveSpacing,
} from "./guards.ts";

export interface OperatorOptions {
  /** Only `cartesian` is implemented; spherical/cylindrical/thetaMode throw (mirrors pypic). */
  readonly geometry?: GeometryType;
}

// f64 output whenever any input is f64 — preserves the disk precision (f32 render, f64 reference),
// matching derived/magnitude. Reads still happen in JS f64 regardless of input storage, so an f64
// output buffer also makes the arithmetic full-precision.
function anyFloat64(...arrays: readonly FloatArray[]): boolean {
  return arrays.some((array) => array instanceof Float64Array);
}

// ∂field/∂axis via np.gradient (edge_order=1): central interior, first-order one-sided at the two
// boundary planes. The axis coordinate of a flat row-major index is `floor(p / stride) % n`, so one
// linear pass handles any axis. NaN/Inf propagate; `?? 0` only satisfies noUncheckedIndexedAccess
// (the ± neighbours are in-bounds by the j-guard).
function partialAlongAxis(
  data: FloatArray,
  shape: readonly number[],
  axis: number,
  spacing: number,
  useFloat64: boolean,
): FloatArray {
  const n = shape[axis] ?? 1;
  if (n < 2) {
    throw new Error(`partialAlongAxis: axis ${axis} needs ≥2 samples (np.gradient), got ${n}`);
  }
  let stride = 1;
  for (let a = axis + 1; a < shape.length; a++) stride *= shape[a] ?? 1;
  const out = useFloat64 ? new Float64Array(data.length) : new Float32Array(data.length);
  const invCentral = 1 / (2 * spacing);
  const invEdge = 1 / spacing;
  for (let p = 0; p < data.length; p++) {
    const j = Math.floor(p / stride) % n;
    if (j === 0) {
      out[p] = ((data[p + stride] ?? 0) - (data[p] ?? 0)) * invEdge;
    } else if (j === n - 1) {
      out[p] = ((data[p] ?? 0) - (data[p - stride] ?? 0)) * invEdge;
    } else {
      out[p] = ((data[p + stride] ?? 0) - (data[p - stride] ?? 0)) * invCentral;
    }
  }
  return out;
}

function subtractInto(a: FloatArray, b: FloatArray): FloatArray {
  for (let i = 0; i < a.length; i++) a[i] = (a[i] ?? 0) - (b[i] ?? 0);
  return a;
}

/** Gradient of a 3D scalar field: `(∂f/∂x, ∂f/∂y, ∂f/∂z)`. */
export function gradient(
  field: FloatArray,
  shape: readonly number[],
  spacing: Vec3,
  options?: OperatorOptions,
): [FloatArray, FloatArray, FloatArray] {
  requireCartesian(options?.geometry, "gradient");
  requirePositiveSpacing(spacing, "gradient");
  require3dScalar(field, shape, "gradient");
  const useFloat64 = field instanceof Float64Array;
  return [
    partialAlongAxis(field, shape, 0, spacing[0], useFloat64),
    partialAlongAxis(field, shape, 1, spacing[1], useFloat64),
    partialAlongAxis(field, shape, 2, spacing[2], useFloat64),
  ];
}

/** Divergence of a 3D vector field: `∂f1/∂x + ∂f2/∂y + ∂f3/∂z`. */
export function divergence(
  f1: FloatArray,
  f2: FloatArray,
  f3: FloatArray,
  shape: readonly number[],
  spacing: Vec3,
  options?: OperatorOptions,
): FloatArray {
  requireCartesian(options?.geometry, "divergence");
  requirePositiveSpacing(spacing, "divergence");
  require3dVector(f1, f2, f3, shape, "divergence");
  const useFloat64 = anyFloat64(f1, f2, f3);
  const out = partialAlongAxis(f1, shape, 0, spacing[0], useFloat64);
  const d2 = partialAlongAxis(f2, shape, 1, spacing[1], useFloat64);
  const d3 = partialAlongAxis(f3, shape, 2, spacing[2], useFloat64);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (d2[i] ?? 0) + (d3[i] ?? 0);
  return out;
}

/**
 * Curl of a 3D vector field:
 * `(∂f3/∂y − ∂f2/∂z, ∂f1/∂z − ∂f3/∂x, ∂f2/∂x − ∂f1/∂y)`.
 */
export function curl(
  f1: FloatArray,
  f2: FloatArray,
  f3: FloatArray,
  shape: readonly number[],
  spacing: Vec3,
  options?: OperatorOptions,
): [FloatArray, FloatArray, FloatArray] {
  requireCartesian(options?.geometry, "curl");
  requirePositiveSpacing(spacing, "curl");
  require3dVector(f1, f2, f3, shape, "curl");
  const useFloat64 = anyFloat64(f1, f2, f3);
  const [d1, d2, d3] = spacing;
  const c1 = subtractInto(
    partialAlongAxis(f3, shape, 1, d2, useFloat64),
    partialAlongAxis(f2, shape, 2, d3, useFloat64),
  );
  const c2 = subtractInto(
    partialAlongAxis(f1, shape, 2, d3, useFloat64),
    partialAlongAxis(f3, shape, 0, d1, useFloat64),
  );
  const c3 = subtractInto(
    partialAlongAxis(f2, shape, 0, d1, useFloat64),
    partialAlongAxis(f1, shape, 1, d2, useFloat64),
  );
  return [c1, c2, c3];
}
