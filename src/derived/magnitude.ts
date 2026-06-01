// Vector-field magnitudes — |B|, |E|, |J|, |V|. Pure typed-array math, mirrors
// pypic.derived (_vector_magnitude + the per-quantity wrappers the compute recipes bind to).

type FloatArray = Float32Array | Float64Array;

/**
 * Euclidean magnitude of a 3-component vector field: `sqrt(c1² + c2² + c3²)`, elementwise.
 * Output is f64 when any input is f64, else f32 — preserving the disk precision (f32 for
 * render, f64 for the TS compute reference). Mirrors pypic.derived._vector_magnitude.
 */
export function vectorMagnitude(c1: FloatArray, c2: FloatArray, c3: FloatArray): FloatArray {
  const n = c1.length;
  if (c2.length !== n || c3.length !== n) {
    throw new Error(
      `vectorMagnitude: component length mismatch (${c1.length}, ${c2.length}, ${c3.length})`,
    );
  }
  const useF64 =
    c1 instanceof Float64Array || c2 instanceof Float64Array || c3 instanceof Float64Array;
  const out = useF64 ? new Float64Array(n) : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Indices are in-bounds by construction; ?? 0 satisfies noUncheckedIndexedAccess.
    const x = c1[i] ?? 0;
    const y = c2[i] ?? 0;
    const z = c3[i] ?? 0;
    out[i] = Math.sqrt(x * x + y * y + z * z);
  }
  return out;
}

export function magneticFieldMagnitude(b1: FloatArray, b2: FloatArray, b3: FloatArray): FloatArray {
  return vectorMagnitude(b1, b2, b3);
}

export function electricFieldMagnitude(e1: FloatArray, e2: FloatArray, e3: FloatArray): FloatArray {
  return vectorMagnitude(e1, e2, e3);
}

export function currentDensityMagnitude(
  j1: FloatArray,
  j2: FloatArray,
  j3: FloatArray,
): FloatArray {
  return vectorMagnitude(j1, j2, j3);
}

export function velocityMagnitude(v1: FloatArray, v2: FloatArray, v3: FloatArray): FloatArray {
  return vectorMagnitude(v1, v2, v3);
}
