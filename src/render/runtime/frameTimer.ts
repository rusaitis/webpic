import type { FrameClock } from "@schema/timing.ts";

// Per-frame GPU timing for the diagnostics panel, render-local — NOT gpu/profiler.ts, which times an
// *owned* compute pass and cannot reach three's internally managed render encoder.
//
// Wall-clock only: performance.now() bracketing device.queue.onSubmittedWorkDone(). Render-pass
// timestamp-query was removed because resolving it loses the device on Metal. The measurement is
// coarser (it includes JS/queue latency), so the panel labels it distinctly.

export interface FrameTimer {
  readonly mode: FrameClock;
  // Call before the render submit; stamps the wall clock.
  beginFrame(): void;
  // Bracket time for the just-submitted frame in ms; NaN to skip (a read still in flight).
  sampleAfterSubmit(): Promise<number>;
}

export function createFrameTimer(device: GPUDevice): FrameTimer {
  let startMs = Number.NaN;
  let isReading = false;
  return {
    mode: "wallclock",
    beginFrame() {
      startMs = performance.now();
    },
    async sampleAfterSubmit() {
      if (isReading) return Number.NaN; // a previous bracket is still draining; skip this frame
      isReading = true;
      try {
        await device.queue.onSubmittedWorkDone();
        return performance.now() - startMs;
      } finally {
        isReading = false;
      }
    },
  };
}
