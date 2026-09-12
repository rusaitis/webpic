// Buffer bookkeeping shared by the two compute kernel runners. Every GPUBuffer a dispatch allocates
// is tracked so one `destroyAll()` in a finally frees them on every path — success, abort, a captured
// validation error, or a device-loss readback rejection.
//
// The three allocations have exactly three shapes, so they are named rather than re-spelled: a
// storage input (created and written in one step), a storage output the pass writes, and the
// MAP_READ staging buffer the output is copied into — MAP_READ and STORAGE are mutually exclusive,
// which is why a readback is always a second buffer.

const BYTES_PER_F32 = 4;

export interface BufferPool {
  storageInput(data: ArrayBufferView | ArrayBuffer): GPUBuffer;
  storageOutput(bytes: number): GPUBuffer;
  readback(bytes: number): GPUBuffer;
  destroyAll(): void;
}

export function createBufferPool(device: GPUDevice): BufferPool {
  const buffers: GPUBuffer[] = [];
  const track = (buffer: GPUBuffer): GPUBuffer => {
    buffers.push(buffer);
    return buffer;
  };
  return {
    storageInput(data) {
      // A zero-length input is legal upstream but not as a buffer size; one f32 stands in.
      const buffer = track(
        device.createBuffer({
          size: Math.max(data.byteLength, BYTES_PER_F32),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(buffer, 0, data);
      return buffer;
    },
    storageOutput: (bytes) =>
      track(
        device.createBuffer({
          size: bytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }),
      ),
    readback: (bytes) =>
      track(
        device.createBuffer({
          size: bytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
      ),
    destroyAll() {
      // Every buffer's map (if any) has settled by the time a caller reaches its finally — the
      // mapAsync is always awaited first, and the throw paths precede it — so destroying is safe.
      for (const buffer of buffers) buffer.destroy();
    },
  };
}
