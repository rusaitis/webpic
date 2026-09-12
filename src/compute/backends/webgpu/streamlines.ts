// STAGED: activates when trace dispatch moves off the main thread.
//
// WebGPU field-line tracer — the GPU twin of numerics/tracing.ts `traceFieldLinesAdaptive`. Fans the
// adaptive Dormand-Prince 5(4) trace out across one GPU invocation per (seed, direction) work-item, then
// reuses the CPU `stitch` + `makeFieldLine` for the "both"/backward join and FieldLine assembly so the
// output is shape-identical to the goldens. Like the field-op backend it is a standalone function, NOT
// a `ComputeBackend` (its output is `FieldLine[]`, not a scalar/vector field) — wired onto the
// store's `recompute()` AbortController seam.

import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import { getDevice } from "@gpu/device.ts";
import { runStreamlineKernel } from "@gpu/streamlineKernel.ts";
import { interpolatorFromDataset } from "@numerics/interp.ts";
import {
  type AdaptiveTraceOptions,
  type FieldLine,
  makeFieldLine,
  reasonFromCode,
  resolveTraceParams,
  type SingleDirResult,
  stitch,
  toSeedList,
  validateSeed,
} from "@numerics/tracing.ts";
import type { Vec3 } from "@schema/types.ts";
import { STREAMLINE_ENTRY, STREAMLINE_WGSL } from "@shaders/kernels/streamline.wgsl.ts";
import { toFloat32 } from "./params.ts";
import { buildStreamlineParams, decodeTraceMeta } from "./streamlineParams.ts";

const EMPTY_DIR: SingleDirResult = {
  points: new Float64Array(0),
  reason: "max_steps",
  maxLocalError: 0,
};

function requireField(data: FieldDataset, name: string): FieldArray {
  const field = data.fields.get(name);
  if (field === undefined) {
    throw new Error(`webgpu streamline tracer: component ${name} not in dataset`);
  }
  return field;
}

function writeSeed(buf: Float32Array, index: number, seed: Float64Array, sign: number): void {
  const o = index * 4;
  buf[o] = seed[0] ?? 0;
  buf[o + 1] = seed[1] ?? 0;
  buf[o + 2] = seed[2] ?? 0;
  buf[o + 3] = sign;
}

// Lift one work-item's vec4 points (xyz + arclength) back to a flat (N, 3) Float64Array + its reason.
function readDir(
  points: Float32Array,
  meta: ArrayBuffer,
  capacity: number,
  workIndex: number,
): SingleDirResult {
  const m = decodeTraceMeta(meta, workIndex);
  const out = new Float64Array(m.nPoints * 3);
  const base = workIndex * capacity * 4;
  for (let p = 0; p < m.nPoints; p++) {
    const src = base + p * 4;
    out[p * 3] = points[src] ?? 0;
    out[p * 3 + 1] = points[src + 1] ?? 0;
    out[p * 3 + 2] = points[src + 2] ?? 0;
  }
  return { points: out, reason: reasonFromCode(m.reason), maxLocalError: m.maxLocalError };
}

/**
 * Trace N field lines from `seeds` on the GPU. Mirrors `traceFieldLinesAdaptive`'s contract (same
 * options, same FieldLine output). Validates every seed on the CPU up front — so a bad seed throws before
 * any device work. Throws on a `terminate` option (a JS predicate isn't GPU-expressible; the kernel
 * covers max_steps/domain_exit/null_point/closed_loop). Requires a live `GPUDevice`.
 */
export async function traceFieldLinesWebgpu(
  data: FieldDataset,
  seeds: ReadonlyArray<Vec3 | readonly number[]> | Float64Array,
  options: AdaptiveTraceOptions = {},
  signal?: AbortSignal,
): Promise<FieldLine[]> {
  if (options.terminate !== undefined) {
    throw new Error("webgpu streamline tracer does not support terminate callbacks (CPU-only)");
  }
  signal?.throwIfAborted();

  const resolved = resolveTraceParams(data, options);
  // Build the interpolator from `data` (not options.interpolator) so the CPU seed validation samples the
  // exact field the kernel uploads. Throws loudly on a degenerate grid / missing component (as pypic).
  const interp = interpolatorFromDataset(data, resolved.components);
  const seedList = toSeedList(seeds);
  for (const s of seedList) validateSeed(interp, s, resolved.nullThreshold);
  const nSeeds = seedList.length;
  if (nSeeds === 0) return [];

  const [c1, c2, c3] = resolved.components;
  const fields: [Float32Array, Float32Array, Float32Array] = [
    toFloat32(requireField(data, c1).data),
    toFloat32(requireField(data, c2).data),
    toFloat32(requireField(data, c3).data),
  ];

  // Expand seeds → work-items. forward/backward: one per seed. both: [0,nSeeds) forward, then backward.
  const both = resolved.direction === "both";
  const dirSign = resolved.direction === "backward" ? -1 : 1;
  const nWork = both ? nSeeds * 2 : nSeeds;
  const seedBuf = new Float32Array(nWork * 4);
  seedList.forEach((s, i) => {
    if (both) {
      writeSeed(seedBuf, i, s, 1);
      writeSeed(seedBuf, i + nSeeds, s, -1);
    } else {
      writeSeed(seedBuf, i, s, dirSign);
    }
  });

  const capacity = resolved.maxSteps + 1;
  const params = buildStreamlineParams(resolved, data.grid, capacity, nWork);
  const { points, meta } = await runStreamlineKernel({
    device: getDevice(),
    wgsl: STREAMLINE_WGSL,
    entryPoint: STREAMLINE_ENTRY,
    fields,
    seeds: seedBuf,
    params,
    capacity,
    nWork,
    signal,
  });

  return seedList.map((s, i) => {
    let fwd = EMPTY_DIR;
    let bwd = EMPTY_DIR;
    if (resolved.direction === "forward") {
      fwd = readDir(points, meta, capacity, i);
    } else if (resolved.direction === "backward") {
      bwd = readDir(points, meta, capacity, i);
    } else {
      fwd = readDir(points, meta, capacity, i);
      bwd = readDir(points, meta, capacity, i + nSeeds);
    }
    const stitched = stitch(resolved.direction, fwd, bwd);
    const seedPoint: Vec3 = [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0];
    return makeFieldLine({
      points: stitched.points,
      fieldName: resolved.fieldName,
      seedPoint,
      normalization: data.normalization,
      direction: resolved.direction,
      reason: stitched.reason,
      atol: resolved.atol,
      rtol: resolved.rtol,
      maxLocalError: stitched.maxLocalError,
      step: data.step,
    });
  });
}
