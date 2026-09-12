// Trilinear vector-field interpolation — the sampler the field-line tracer's dr/ds = B̂(r) RHS
// evaluates at arbitrary positions. Mirrors pypic's traces.VectorFieldInterpolator (scipy
// RegularGridInterpolator, linear, fill_value=nan) over a uniform grid.
//
// pypic grids are CELL-CENTERED: sample i sits at origin + (i + 0.5)·dx, so the physical→index map
// carries a −0.5 offset and the in-domain range is t ∈ [0, dim−1].

import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";

type ComponentArray = FieldArray["data"]; // Float32Array | Float64Array, no @schema import

export interface VectorFieldInterpolator {
  /**
   * Trilinear-sample the vector field at `point` (length-3, code units) into `out` (length-3).
   * Returns false when `point` lies outside the grid domain — the caller treats that as a domain
   * exit and leaves `out` untouched.
   */
  sample(point: Float64Array, out: Float64Array): boolean;
}

const DEFAULT_COMPONENTS = ["B_1", "B_2", "B_3"] as const;

function requireComponent(data: FieldDataset, name: string): FieldArray {
  const field = data.fields.get(name);
  if (field === undefined) {
    const have = [...data.fields.keys()].join(", ");
    throw new Error(`field-line tracing: component ${name} not in dataset (have: ${have})`);
  }
  return field;
}

/**
 * Build a trilinear interpolator for the three vector components of `data` (default `B_1,B_2,B_3`).
 * Throws on a non-cartesian grid, a non-3-D grid, an axis with < 2 samples, a missing component, or a
 * component whose shape disagrees with the grid — the same guards pypic's RegularGridInterpolator
 * enforces, surfaced loudly rather than as a silent NaN field.
 */
export function interpolatorFromDataset(
  data: FieldDataset,
  components: readonly [string, string, string] = DEFAULT_COMPONENTS,
): VectorFieldInterpolator {
  const { grid } = data;
  if (grid.geometry !== "cartesian") {
    throw new Error(`field-line tracing needs a cartesian grid, got ${grid.geometry}`);
  }
  const dims = grid.dimensions;
  if (dims.length !== 3) {
    throw new Error(`field-line tracing needs a 3-D grid, got ${dims.length}-D`);
  }

  const nx = dims[0] ?? 0;
  const ny = dims[1] ?? 0;
  const nz = dims[2] ?? 0;
  for (let axis = 0; axis < 3; axis++) {
    const n = dims[axis] ?? 0;
    if (n < 2) throw new Error(`field-line tracing: axis ${axis} has ${n} samples, needs ≥ 2`);
  }

  const [n1, n2, n3] = components;
  const f1 = requireComponent(data, n1);
  const f2 = requireComponent(data, n2);
  const f3 = requireComponent(data, n3);
  const expected = nx * ny * nz;
  for (const f of [f1, f2, f3]) {
    if (f.data.length !== expected) {
      throw new Error(
        `field-line tracing: component ${f.meta.longName} has ${f.data.length} samples, grid wants ${expected}`,
      );
    }
  }
  const c1 = f1.data;
  const c2 = f2.data;
  const c3 = f3.data;

  const ox = grid.origin[0] ?? 0;
  const oy = grid.origin[1] ?? 0;
  const oz = grid.origin[2] ?? 0;
  const invDx = 1 / (grid.spacing[0] ?? 1);
  const invDy = 1 / (grid.spacing[1] ?? 1);
  const invDz = 1 / (grid.spacing[2] ?? 1);

  // Row-major strides for index (i*ny + j)*nz + k; sz = 1.
  const sx = ny * nz;
  const sy = nz;
  const nxm1 = nx - 1;
  const nym1 = ny - 1;
  const nzm1 = nz - 1;
  const nxm2 = nx - 2;
  const nym2 = ny - 2;
  const nzm2 = nz - 2;

  // `?? 0` on the corner reads only satisfies noUncheckedIndexedAccess — the clamps above put every
  // index in bounds.
  const blend = (c: ComponentArray, base: number, fx: number, fy: number, fz: number): number => {
    const c000 = c[base] ?? 0;
    const c100 = c[base + sx] ?? 0;
    const c010 = c[base + sy] ?? 0;
    const c110 = c[base + sx + sy] ?? 0;
    const c001 = c[base + 1] ?? 0;
    const c101 = c[base + sx + 1] ?? 0;
    const c011 = c[base + sy + 1] ?? 0;
    const c111 = c[base + sx + sy + 1] ?? 0;
    const c00 = c000 + fx * (c100 - c000);
    const c10 = c010 + fx * (c110 - c010);
    const c01 = c001 + fx * (c101 - c001);
    const c11 = c011 + fx * (c111 - c011);
    const c0 = c00 + fy * (c10 - c00);
    const c1v = c01 + fy * (c11 - c01);
    return c0 + fz * (c1v - c0);
  };

  return {
    sample(point: Float64Array, out: Float64Array): boolean {
      const tx = ((point[0] ?? Number.NaN) - ox) * invDx - 0.5;
      const ty = ((point[1] ?? Number.NaN) - oy) * invDy - 0.5;
      const tz = ((point[2] ?? Number.NaN) - oz) * invDz - 0.5;
      // The `>= && <=` form (vs `< || >`) rejects NaN too: a NaN coordinate fails the chain → false.
      if (!(tx >= 0 && tx <= nxm1 && ty >= 0 && ty <= nym1 && tz >= 0 && tz <= nzm1)) return false;

      let i0 = Math.floor(tx);
      let j0 = Math.floor(ty);
      let k0 = Math.floor(tz);
      if (i0 > nxm2) i0 = nxm2; // tx == dim−1 lands on the last cell with frac 1
      if (j0 > nym2) j0 = nym2;
      if (k0 > nzm2) k0 = nzm2;

      const base = (i0 * ny + j0) * nz + k0;
      const fx = tx - i0;
      const fy = ty - j0;
      const fz = tz - k0;
      out[0] = blend(c1, base, fx, fy, fz);
      out[1] = blend(c2, base, fx, fy, fz);
      out[2] = blend(c3, base, fx, fy, fz);
      return true;
    },
  };
}
