import { createBufferPool } from "./bufferPool.ts";

// One-shot WebGPU runner for the streamline kernel — the GPU twin of `computeKernel.ts`, but for the
// fixed 7-binding streamline layout (3 field buffers + params + seeds + two read-write outputs) with two
// readbacks (the vec4 point buffer and the per-work-item meta). Recipe-agnostic: the `compute` backend
// supplies the WGSL, entry point, packed params, and f32 field/seed buffers. Deliberately minimal — no
// pipeline cache, no vramLedger entry (these scratch buffers live for one dispatch and are destroyed
// here). Dispatch is 1-D over work-items (one invocation per (seed, direction)); `nWork` is small, so no
// grid-stride loop is needed.

const WORKGROUP_SIZE = 64;
const BYTES_PER_F32 = 4;
const FLOATS_PER_POINT = 4; // vec4<f32>: xyz + arclength
const TRACE_META_BYTES = 16; // u32 nPoints, u32 reason, u32 nSteps, f32 maxLocalError

export interface StreamlineKernelSpec {
  readonly device: GPUDevice;
  readonly wgsl: string;
  readonly entryPoint: string;
  // The three vector-field components (row-major, already f32), bound at binding 0/1/2.
  readonly fields: readonly [Float32Array, Float32Array, Float32Array];
  // Work-item seeds: `nWork` × 4 floats (x, y, z, sign), bound at binding 4.
  readonly seeds: Float32Array;
  // Packed `Params` (binding 3), opaque bytes matching the WGSL struct.
  readonly params: ArrayBuffer;
  // Per-work-item point slot count (= maxSteps + 1).
  readonly capacity: number;
  // Number of (seed, direction) work-items.
  readonly nWork: number;
  readonly signal?: AbortSignal | undefined;
}

export interface StreamlineKernelResult {
  // Flat `nWork` × `capacity` × 4 floats: each point is (x, y, z, arclength).
  readonly points: Float32Array;
  // Raw `nWork` × 16-byte `TraceMeta` records; decode with `decodeTraceMeta`.
  readonly meta: ArrayBuffer;
}

// Run the streamline kernel and read back the point + meta buffers. Throws on abort (before submit /
// before readback), on a captured WGSL/bind validation error, or on a device-loss readback rejection —
// never silently returns garbage. All GPU buffers are destroyed before returning (or throwing).
export async function runStreamlineKernel(
  spec: StreamlineKernelSpec,
): Promise<StreamlineKernelResult> {
  const { device, wgsl, entryPoint, fields, seeds, params, capacity, nWork, signal } = spec;
  signal?.throwIfAborted();

  const pointsBytes = Math.max(nWork * capacity * FLOATS_PER_POINT * BYTES_PER_F32, BYTES_PER_F32);
  const metaBytes = Math.max(nWork * TRACE_META_BYTES, TRACE_META_BYTES);

  const pool = createBufferPool(device);

  device.pushErrorScope("validation");
  try {
    const module = device.createShaderModule({ code: wgsl });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint },
    });

    const [f1, f2, f3] = fields;
    const paramsBuffer = pool.storageInput(params);
    const pointsBuffer = pool.storageOutput(pointsBytes);
    const metaBuffer = pool.storageOutput(metaBytes);

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: pool.storageInput(f1) } },
        { binding: 1, resource: { buffer: pool.storageInput(f2) } },
        { binding: 2, resource: { buffer: pool.storageInput(f3) } },
        { binding: 3, resource: { buffer: paramsBuffer } },
        { binding: 4, resource: { buffer: pool.storageInput(seeds) } },
        { binding: 5, resource: { buffer: pointsBuffer } },
        { binding: 6, resource: { buffer: metaBuffer } },
      ],
    });

    const pointsReadback = pool.readback(pointsBytes);
    const metaReadback = pool.readback(metaBytes);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(nWork / WORKGROUP_SIZE)));
    pass.end();
    encoder.copyBufferToBuffer(pointsBuffer, 0, pointsReadback, 0, pointsBytes);
    encoder.copyBufferToBuffer(metaBuffer, 0, metaReadback, 0, metaBytes);
    device.queue.submit([encoder.finish()]);

    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(`webgpu streamline kernel "${entryPoint}": ${validationError.message}`);
    }

    signal?.throwIfAborted();
    // mapAsync resolves only once the producing GPU work completes; on device loss it rejects, which we
    // let propagate as a clean failure (recovery belongs to device.ts).
    await pointsReadback.mapAsync(GPUMapMode.READ);
    const points = new Float32Array(pointsReadback.getMappedRange().slice(0));
    pointsReadback.unmap();

    await metaReadback.mapAsync(GPUMapMode.READ);
    const meta = metaReadback.getMappedRange().slice(0);
    metaReadback.unmap();

    return { points, meta };
  } finally {
    pool.destroyAll();
  }
}
