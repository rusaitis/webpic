import type { Vec3 } from "./types.ts";

// Scalar/geometry primitives shared across layers. They live in schema (the DAG root, imported by
// everyone) so store, ui, render, and app share one definition instead of re-deriving them — no other
// layer is importable by all consumers without a boundary violation.

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Build a Vec3 from components — the single widening site, so call sites construct the readonly
// 3-tuple without `as Vec3` on a fresh literal (TS infers `[x, y, z]` as the mutable `number[]`).
export function vec3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

// Half-extent of the unit box centered at the origin: it spans [-0.5, 0.5]³, the object space the
// volume mesh, picker, and scene overlay all share before a dataset's world aspect scales it.
export const UNIT_BOX_HALF_EXTENT: Vec3 = [0.5, 0.5, 0.5];
