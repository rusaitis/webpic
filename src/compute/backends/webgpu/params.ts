import type { FloatArray } from "@schema/types.ts";

// Pure CPU-side helpers for the WebGPU field kernels — no GPU access, so they unit-test in Node.

// Packed-params byte layout. Mirrors the WGSL `Params` struct in `shaders/kernels/prelude.wgsl.ts`
// exactly (std430, scalars only → tight 4-byte packing): nx,ny,nz (u32) · invDx,invDy,invDz (f32) ·
// n (u32) · component (u32). Little-endian (WebGPU is LE). Keep the two definitions in lockstep.
export const PARAMS_BYTE_LENGTH = 32;

/**
 * Pack the grid parameters a kernel needs into the `Params` byte layout. `shape`/`spacing` are the
 * row-major `[nx,ny,nz]` dims and `[dx,dy,dz]` spacing; missing entries default to 1 (lets the
 * magnitude kernels, which ignore the grid, pass a 1-D shape harmlessly). Inverse spacing is baked
 * here so the shader multiplies; `component` selects the curl output component (ignored otherwise).
 */
export function buildKernelParams(
  shape: readonly number[],
  spacing: readonly number[],
  component: number,
  totalElements: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMS_BYTE_LENGTH);
  const view = new DataView(buffer);
  view.setUint32(0, shape[0] ?? 1, true);
  view.setUint32(4, shape[1] ?? 1, true);
  view.setUint32(8, shape[2] ?? 1, true);
  view.setFloat32(12, 1 / (spacing[0] ?? 1), true);
  view.setFloat32(16, 1 / (spacing[1] ?? 1), true);
  view.setFloat32(20, 1 / (spacing[2] ?? 1), true);
  view.setUint32(24, totalElements, true);
  view.setUint32(28, component, true);
  return buffer;
}

/** The GPU is f32-only: pass a Float32Array through untouched, downcast a Float64Array (one copy). */
export function toFloat32(array: FloatArray): Float32Array {
  return array instanceof Float32Array ? array : Float32Array.from(array);
}
