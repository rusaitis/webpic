import { BYTES_PER_F32, createBufferPool } from "./bufferPool.ts";

// A thin, one-shot WebGPU compute runner: upload N read-only f32 input buffers plus a params buffer,
// dispatch a single-output kernel, read the result back. Recipe-agnostic — the WebGPU compute backend
// supplies the WGSL, entry point, and packed params. Deliberately minimal: no pipeline cache and no
// vramLedger entry, because these scratch buffers live for one dispatch and would otherwise flicker
// the steady-state VRAM HUD. Dispatch is 1-D and capped at the WebGPU-guaranteed 65535 workgroups;
// the kernel's grid-stride loop covers any element count above that.

const WORKGROUP_SIZE = 256;
const MAX_WORKGROUPS_PER_DIM = 65535; // WebGPU spec guaranteed minimum; the kernel loops past it

export interface FieldKernelSpec {
  readonly device: GPUDevice;
  readonly wgsl: string;
  readonly entryPoint: string;
  // Read-only inputs, each uploaded to a storage buffer at binding 0..N-1 (already f32).
  readonly inputs: readonly Float32Array[];
  // Packed kernel parameters (binding N), opaque bytes matching the WGSL `Params` struct.
  readonly params: ArrayBuffer;
  // Output element count (binding N+1); the readback is `outputElements` f32 values.
  readonly outputElements: number;
  // `| undefined` (not bare `?`) so a caller can forward a possibly-undefined signal under
  // exactOptionalPropertyTypes without branching at the call site.
  readonly signal?: AbortSignal | undefined;
}

// Run a single-output field kernel and return its result as a fresh `Float32Array`. Throws on
// abort (before submit / before readback), on a captured WGSL/bind validation error, or on a
// device-loss readback rejection — never silently returns a garbage buffer. All GPU buffers are
// destroyed before returning (or throwing).
export async function runFieldKernel(spec: FieldKernelSpec): Promise<Float32Array> {
  const { device, wgsl, entryPoint, inputs, params, outputElements, signal } = spec;
  signal?.throwIfAborted();

  const outputBytes = outputElements * BYTES_PER_F32;
  const pool = createBufferPool(device);

  // Validation errors from createComputePipeline/dispatch surface asynchronously; without this scope
  // a WGSL or bind mismatch yields a zero/garbage buffer that reads as a numeric parity failure.
  device.pushErrorScope("validation");
  try {
    const module = device.createShaderModule({ code: wgsl });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint },
    });

    const entries: GPUBindGroupEntry[] = inputs.map((array, binding) => ({
      binding,
      resource: { buffer: pool.storageInput(array) },
    }));
    entries.push({ binding: inputs.length, resource: { buffer: pool.storageInput(params) } });
    const outputBuffer = pool.storageOutput(outputBytes);
    entries.push({ binding: inputs.length + 1, resource: { buffer: outputBuffer } });
    const readbackBuffer = pool.readback(outputBytes);

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    const workgroups = Math.min(Math.ceil(outputElements / WORKGROUP_SIZE), MAX_WORKGROUPS_PER_DIM);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputBytes);
    device.queue.submit([encoder.finish()]);

    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(`webgpu kernel "${entryPoint}": ${validationError.message}`);
    }

    signal?.throwIfAborted();
    // mapAsync resolves only once the producing GPU work completes; on device loss it rejects, which
    // we let propagate as a clean failure (recovery belongs to device.ts, not here).
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    // Copy out before unmap — getMappedRange()'s ArrayBuffer detaches on unmap (use-after-free else).
    const result = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();
    return result;
  } finally {
    pool.destroyAll();
  }
}
