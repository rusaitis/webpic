import type { GeometryType } from "@containers/field_dataset.ts";
import type { FloatArray } from "@schema/types.ts";

// The preconditions every grid operator shares, so the WGSL path refuses exactly what the TS
// reference refuses. `operation` is the caller's own name — it leads the message (CLAUDE.md §Comments
// & docs), and on the GPU path it carries the backend too.

export function requireCartesian(geometry: GeometryType | undefined, operation: string): void {
  if (geometry !== undefined && geometry !== "cartesian") {
    throw new Error(`${operation}: ${geometry} geometry not implemented`);
  }
}

export function requirePositiveSpacing(spacing: readonly number[], operation: string): void {
  for (const [axis, delta] of spacing.entries()) {
    // `!(delta > 0)` also rejects NaN spacing (NaN > 0 is false).
    if (!(delta > 0)) {
      throw new Error(`${operation}: grid spacing must be positive, got ${delta} on axis ${axis}`);
    }
  }
}

export function gridVolume(shape: readonly number[]): number {
  let volume = 1;
  for (const dim of shape) volume *= dim;
  return volume;
}

export function require3dScalar(
  field: FloatArray,
  shape: readonly number[],
  operation: string,
): void {
  if (shape.length !== 3) {
    throw new Error(`${operation}: expected a 3D grid, got ${shape.length}D`);
  }
  const volume = gridVolume(shape);
  if (field.length !== volume) {
    throw new Error(`${operation}: field length ${field.length} ≠ grid volume ${volume}`);
  }
}

export function require3dVector(
  f1: FloatArray,
  f2: FloatArray,
  f3: FloatArray,
  shape: readonly number[],
  operation: string,
): void {
  if (shape.length !== 3) {
    throw new Error(`${operation}: expected a 3D grid, got ${shape.length}D`);
  }
  const volume = gridVolume(shape);
  if (f1.length !== volume || f2.length !== volume || f3.length !== volume) {
    throw new Error(
      `${operation}: component length ≠ grid volume (${f1.length}/${f2.length}/${f3.length} vs ${volume})`,
    );
  }
}
