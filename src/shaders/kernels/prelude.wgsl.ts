// Standalone WGSL fragments shared by the field-operator kernels (NOT three.js TSL — these are
// raw compute shaders consumed by `gpu/computeKernel.ts`, and the eventual rustpic-shared form).
// Single-sourced here so the row-major indexing and the np.gradient stencil have exactly one
// definition; `fieldOps.wgsl.ts` concatenates these strings ahead of its entry points.

// The shared kernel parameters. **Scalars only** — std430 (the `storage` address space) packs
// 4-byte scalars tightly (no 16-byte rounding), so this maps 1:1 onto the DataView layout built in
// `compute/backends/webgpu/params.ts`. Keep the two in lockstep: never add a vec/array member here
// (std430 would 16-byte-align it) without mirroring the offset on the CPU side. Strides are derived
// in-shader from the dims so the row-major formula lives in exactly one place.
export const PARAMS_STRUCT = /* wgsl */ `
struct Params {
  nx: u32,
  ny: u32,
  nz: u32,
  invDx: f32,
  invDy: f32,
  invDz: f32,
  n: u32,        // total element count (grid volume)
  component: u32, // curl output component (0/1/2); ignored by magnitude/divergence
};
`;

// The finite-difference stencil, an exact mirror of `coordinates/operators.ts` `partialAlongAxis`
// (np.gradient edge_order=1): second-order central in the interior, first-order one-sided at the two
// boundary planes. `axisStencil` resolves the ± neighbour indices with the edge guarded *on the
// index* (atLow → lo=i, atHigh → hi=i) so a u32 underflow at i−stride never becomes an out-of-bounds
// read — the wrapped index is computed but `select` discards it, and the kept index is always valid.
// The axis coordinate of a flat row-major index is `(i / stride) % n` (u32 floor-div + mod match JS
// `Math.floor(p/stride) % n` for non-negative integers).
export const STENCIL_PRELUDE = /* wgsl */ `
struct AxisStencil { lo: u32, hi: u32, atLow: bool, atHigh: bool };

fn axisStencil(i: u32, stride: u32, n: u32) -> AxisStencil {
  let j = (i / stride) % n;
  let atLow = j == 0u;
  let atHigh = j == (n - 1u);
  return AxisStencil(select(i - stride, i, atLow), select(i + stride, i, atHigh), atLow, atHigh);
}

fn diff1(left: f32, center: f32, right: f32, atLow: bool, atHigh: bool, invSpacing: f32) -> f32 {
  if (atLow)  { return (right - center) * invSpacing; }
  if (atHigh) { return (center - left)  * invSpacing; }
  return (right - left) * 0.5 * invSpacing;
}
`;
