import type { GridInfo } from "@containers/field_dataset.ts";
import type { ResolvedTraceParams } from "@numerics/tracing.ts";

// Pure CPU-side byte-layout mirrors for the WGSL streamline kernel — no GPU access, so they unit-test in
// Node. Both structs are std430 (scalars-only / vec-free), little-endian (WebGPU is LE).

// Packed `Params` layout. Mirrors the `Params` struct in `shaders/kernels/streamline.wgsl.ts` exactly
// (4-byte tight packing → 84 bytes). Keep the two in lockstep — never reorder a field without updating
// both. Unlike the field-op `Params` this carries the grid **origin** (the cell-centered −0.5 index map
// needs absolute coordinates) and the full adaptive-tolerance set.
export const STREAMLINE_PARAMS_BYTE_LENGTH = 84;

/**
 * Pack a resolved trace into the streamline `Params` byte layout. `capacity` is the per-work-item point
 * slot count (= maxSteps + 1); `nWork` is the number of (seed, direction) work-items. `loopTol === null`
 * (closed-loop disabled) is encoded as `loopEnabled = 0` with a 0 placeholder threshold. Inverse spacing
 * is baked here so the shader multiplies.
 */
export function buildStreamlineParams(
  resolved: ResolvedTraceParams,
  grid: GridInfo,
  capacity: number,
  nWork: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(STREAMLINE_PARAMS_BYTE_LENGTH);
  const view = new DataView(buffer);
  view.setUint32(0, grid.dimensions[0] ?? 1, true);
  view.setUint32(4, grid.dimensions[1] ?? 1, true);
  view.setUint32(8, grid.dimensions[2] ?? 1, true);
  view.setFloat32(12, grid.origin[0] ?? 0, true);
  view.setFloat32(16, grid.origin[1] ?? 0, true);
  view.setFloat32(20, grid.origin[2] ?? 0, true);
  view.setFloat32(24, 1 / (grid.spacing[0] ?? 1), true);
  view.setFloat32(28, 1 / (grid.spacing[1] ?? 1), true);
  view.setFloat32(32, 1 / (grid.spacing[2] ?? 1), true);
  view.setFloat32(36, resolved.atol, true);
  view.setFloat32(40, resolved.rtol, true);
  view.setFloat32(44, resolved.stepSizeInit, true);
  view.setFloat32(48, resolved.minStep, true);
  view.setFloat32(52, resolved.maxStep, true);
  view.setFloat32(56, resolved.nullThreshold, true);
  view.setFloat32(60, resolved.loopTol ?? 0, true);
  view.setFloat32(64, resolved.loopMinArclen, true);
  view.setUint32(68, resolved.loopTol === null ? 0 : 1, true);
  view.setUint32(72, resolved.maxSteps, true);
  view.setUint32(76, capacity, true);
  view.setUint32(80, nWork, true);
  return buffer;
}

// Packed `TraceMeta` layout (one per work-item). Mirrors the WGSL `TraceMeta` struct: 16 bytes, std430
// array stride 16. `reason` is a `REASON_CODES` integer (decode via `reasonFromCode`).
export const TRACE_META_BYTE_LENGTH = 16;

export interface DecodedTraceMeta {
  readonly nPoints: number;
  readonly reason: number;
  readonly nSteps: number;
  readonly maxLocalError: number;
}

/** Decode the `index`-th `TraceMeta` from the kernel's meta readback buffer. */
export function decodeTraceMeta(meta: ArrayBuffer, index: number): DecodedTraceMeta {
  const view = new DataView(meta, index * TRACE_META_BYTE_LENGTH, TRACE_META_BYTE_LENGTH);
  return {
    nPoints: view.getUint32(0, true),
    reason: view.getUint32(4, true),
    nSteps: view.getUint32(8, true),
    maxLocalError: view.getFloat32(12, true),
  };
}
