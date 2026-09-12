// GPU frame timing with two interchangeable backends behind one interface:
// `timestamp-query` (GPUQuerySet, nanosecond-accurate GPU time) when the device
// supports it, else a `performance.now()` + `queue.onSubmittedWorkDone()` wall-clock
// fallback (coarser — includes JS/queue latency — but always available). The
// diagnostics panel drives this; both paths ship now.

import type { GpuCapabilities } from "./capabilities.ts";

type GpuProfilerMode = "timestamp" | "wallclock";

export interface GpuProfiler {
  readonly mode: GpuProfilerMode;
  // Mark the start of a frame. Wallclock: stamps `performance.now()`; timestamp: no-op.
  begin(): void;
  // Timestamp writes to attach to ONE pass per frame; undefined in wallclock mode.
  timestampWrites(): GPUComputePassTimestampWrites | undefined;
  // Resolve the query set into the readback buffer (encode after the pass). No-op otherwise.
  resolve(encoder: GPUCommandEncoder): void;
  // GPU time for the last submitted frame in milliseconds; NaN while a read is in flight.
  readLatencyMs(): Promise<number>;
  dispose(): void;
}

const TIMESTAMP_COUNT = 2; // begin + end of a single pass
const BYTES_PER_TIMESTAMP = 8; // u64 nanoseconds

export function createGpuProfiler(device: GPUDevice, capabilities: GpuCapabilities): GpuProfiler {
  return capabilities.hasTimestampQuery
    ? createTimestampProfiler(device)
    : createWallclockProfiler(device);
}

function createTimestampProfiler(device: GPUDevice): GpuProfiler {
  const byteSize = TIMESTAMP_COUNT * BYTES_PER_TIMESTAMP;
  const querySet = device.createQuerySet({ type: "timestamp", count: TIMESTAMP_COUNT });
  const resolveBuffer = device.createBuffer({
    size: byteSize,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    size: byteSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let reading = false;

  return {
    mode: "timestamp",
    begin() {
      // GPU time comes from the query set, not the CPU clock — nothing to stamp.
    },
    timestampWrites() {
      return { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    },
    resolve(encoder) {
      encoder.resolveQuerySet(querySet, 0, TIMESTAMP_COUNT, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, byteSize);
    },
    async readLatencyMs() {
      if (reading) return Number.NaN; // a map is still in flight; skip this frame
      reading = true;
      try {
        await readBuffer.mapAsync(GPUMapMode.READ);
        // Copy out before unmap — getMappedRange()'s view detaches on unmap.
        const stamps = new BigUint64Array(readBuffer.getMappedRange().slice(0));
        readBuffer.unmap();
        const beginNs = stamps[0] ?? 0n; // count=2 guarantees both, ?? satisfies the checker
        const endNs = stamps[1] ?? 0n;
        return Number(endNs - beginNs) / 1e6;
      } finally {
        reading = false;
      }
    },
    dispose() {
      querySet.destroy();
      resolveBuffer.destroy();
      readBuffer.destroy();
    },
  };
}

function createWallclockProfiler(device: GPUDevice): GpuProfiler {
  let startMs = Number.NaN;
  return {
    mode: "wallclock",
    begin() {
      startMs = performance.now();
    },
    timestampWrites() {
      return undefined;
    },
    resolve() {
      // No query set in wallclock mode — timing is taken around the submission.
    },
    async readLatencyMs() {
      await device.queue.onSubmittedWorkDone();
      return performance.now() - startMs;
    },
    dispose() {
      // Wallclock holds no GPU resources.
    },
  };
}
