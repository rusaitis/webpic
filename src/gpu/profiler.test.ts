import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GpuCapabilities } from "./capabilities.ts";
import { createGpuProfiler } from "./profiler.ts";

function caps(hasTimestampQuery: boolean): GpuCapabilities {
  return {
    hasTimestampQuery,
    hasShaderF16: false,
    hasSubgroups: false,
    limits: {
      maxTextureDimension2D: 0,
      maxTextureDimension3D: 0,
      maxBufferSize: 0,
      maxStorageBufferBindingSize: 0,
      maxComputeWorkgroupSizeX: 0,
      maxComputeInvocationsPerWorkgroup: 0,
    },
    adapter: { vendor: "", architecture: "", device: "", description: "" },
  };
}

describe("wallclock profiler", () => {
  it("is selected when timestamp-query is unavailable", () => {
    const device = {
      queue: { onSubmittedWorkDone: () => Promise.resolve() },
    } as unknown as GPUDevice;
    const profiler = createGpuProfiler(device, caps(false));
    expect(profiler.mode).toBe("wallclock");
    expect(profiler.timestampWrites()).toBeUndefined();
  });

  it("measures elapsed wall time around GPU submission", async () => {
    let releaseQueue: () => void = () => {};
    const device = {
      queue: {
        onSubmittedWorkDone: () =>
          new Promise<undefined>((resolve) => {
            releaseQueue = () => resolve(undefined);
          }),
      },
    } as unknown as GPUDevice;
    const nowSpy = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(108);

    const profiler = createGpuProfiler(device, caps(false));
    profiler.begin(); // performance.now() -> 100
    const pending = profiler.readLatencyMs();
    releaseQueue();
    expect(await pending).toBe(8); // performance.now() -> 108

    nowSpy.mockRestore();
  });
});

describe("timestamp profiler", () => {
  beforeEach(() => {
    // @webgpu/types provides only types; the flag globals must exist at runtime.
    vi.stubGlobal("GPUBufferUsage", { QUERY_RESOLVE: 512, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeTimestampDevice(stamps: readonly bigint[] = [0n, 0n]) {
    const destroyed: string[] = [];
    const labels = ["resolveBuffer", "readBuffer"];
    let bufferIndex = 0;
    const mapped = new ArrayBuffer(16);
    new BigUint64Array(mapped).set(stamps);

    const device = {
      createQuerySet: () => ({ destroy: () => destroyed.push("querySet") }),
      createBuffer: () => {
        const label = labels[bufferIndex] ?? `buffer${bufferIndex}`;
        bufferIndex += 1;
        return {
          mapAsync: async () => undefined,
          getMappedRange: () => mapped,
          unmap: () => {},
          destroy: () => destroyed.push(label),
        };
      },
    } as unknown as GPUDevice;
    return { device, destroyed: () => destroyed };
  }

  it("is selected when timestamp-query is available and exposes a 2-index write set", () => {
    const profiler = createGpuProfiler(makeTimestampDevice().device, caps(true));
    expect(profiler.mode).toBe("timestamp");
    const writes = profiler.timestampWrites();
    expect(writes?.beginningOfPassWriteIndex).toBe(0);
    expect(writes?.endOfPassWriteIndex).toBe(1);
  });

  it("computes the nanosecond delta from the readback buffer as ms", async () => {
    const profiler = createGpuProfiler(
      makeTimestampDevice([1_000_000n, 4_000_000n]).device, // begin, end (ns)
      caps(true),
    );
    expect(await profiler.readLatencyMs()).toBe(3); // (4e6 - 1e6) ns = 3 ms
  });

  it("destroys the query set and both buffers on dispose", () => {
    const device = makeTimestampDevice();
    const profiler = createGpuProfiler(device.device, caps(true));
    profiler.dispose();
    expect(device.destroyed()).toEqual(["querySet", "resolveBuffer", "readBuffer"]);
  });
});
