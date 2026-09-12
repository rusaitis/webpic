import { describe, expect, it, vi } from "vitest";
import {
  createPerfSampler,
  type FrameTimingMessage,
  PERF_EMA_ALPHA,
  PERF_IDLE_GAP_MS,
  type PerfSampleMessage,
} from "./perfSampler.ts";

// The HUD sampler against an injected clock + a fake frame timer: pins the interval EMA, the idle-gap
// reset, and the ≤5 Hz GPU-sync throttle without a renderer or display loop.

const CPU_ENCODE_MS = 3; // the fake paint advances the clock by this much
const GPU_MS = 7;

function makeRig(options: { readonly timer?: boolean } = {}) {
  let clock = 0;
  const samples: PerfSampleMessage[] = [];
  const timings: FrameTimingMessage[] = [];
  const gpuSampledAt: number[] = [];
  const reportFault = vi.fn();
  const timer = {
    mode: "wallclock" as const,
    beginFrame: vi.fn(() => {
      gpuSampledAt.push(clock);
    }),
    sampleAfterSubmit: vi.fn(async () => GPU_MS),
  };
  const sampler = createPerfSampler({
    now: () => clock,
    frameTimer: () => (options.timer === false ? undefined : timer),
    governorScale: () => 0.85,
    vramSnapshot: () => ({
      totalBytes: 42,
      byKey: [
        ["volume", 30],
        ["rt", 6],
        ["a", 2],
        ["b", 2],
        ["c", 1],
        ["d", 1],
      ],
    }),
    readHeapBytes: () => 1000,
    post: (message) => {
      if (message.kind === "perfSample") samples.push(message);
      else timings.push(message);
    },
    reportFault,
  });
  const paint = vi.fn(() => {
    clock += CPU_ENCODE_MS;
  });
  // Paint one frame at wall time `atMs`, then let the async GPU sample land.
  async function paintAt(atMs: number): Promise<void> {
    clock = atMs;
    sampler.paintPerf(paint);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { sampler, samples, timings, gpuSampledAt, timer, paint, reportFault, paintAt };
}

describe("createPerfSampler", () => {
  it("paints every frame but syncs the GPU at most once per PERF_GPU_SAMPLE_MS", async () => {
    const rig = makeRig();
    const frames: number[] = [];
    for (let t = 0; t < 1000; t += 16) frames.push(t);
    for (const t of frames) await rig.paintAt(t);

    expect(rig.paint).toHaveBeenCalledTimes(frames.length);
    // The first frame samples at once (no prior sample), then only once the throttle has elapsed:
    // 16 ms frames land the next sync at the 13th frame (208 ms), never inside the 200 ms window.
    const expected = [0, 208, 416, 624, 832];
    expect(rig.gpuSampledAt).toEqual(expected);
    // Every posted sample is an on-demand one carrying the bracket + the cheap snapshots.
    expect(rig.samples).toHaveLength(expected.length);
    for (const sample of rig.samples) {
      expect(sample).toMatchObject({
        kind: "perfSample",
        cpuEncodeMs: CPU_ENCODE_MS,
        frameWallMs: GPU_MS,
        isContinuous: false,
        governorScale: 0.85,
        vramBytes: 42,
        workerHeapBytes: 1000,
      });
      expect(sample.vramByKey).toHaveLength(5); // top-N of the six tracked keys
    }
    expect(rig.reportFault).not.toHaveBeenCalled();
  });

  it("smooths the painted-frame interval with the EMA", async () => {
    const rig = makeRig();
    // Every frame lands a GPU sample (spacing ≥ the throttle), so each one exposes the live EMA.
    await rig.paintAt(0);
    await rig.paintAt(200);
    await rig.paintAt(400);
    await rig.paintAt(700);
    const intervals = rig.samples.map((s) => s.frameIntervalMs);
    expect(intervals[0]).toBeNaN(); // no previous paint
    expect(intervals[1]).toBe(200); // seeded by the first interval
    expect(intervals[2]).toBe(200);
    expect(intervals[3]).toBeCloseTo(200 + PERF_EMA_ALPHA * (300 - 200), 12);
  });

  it("resets the EMA on an idle gap instead of folding it in, and holds at the exact threshold", async () => {
    const rig = makeRig();
    await rig.paintAt(0);
    await rig.paintAt(200);
    await rig.paintAt(400); // EMA 200
    await rig.paintAt(400 + PERF_IDLE_GAP_MS + 1); // a resume after idle
    expect(rig.samples.at(-1)?.frameIntervalMs).toBeNaN();
    await rig.paintAt(400 + PERF_IDLE_GAP_MS + 1 + 200); // fresh seed, not 200 blended with the gap
    expect(rig.samples.at(-1)?.frameIntervalMs).toBe(200);
    await rig.paintAt(400 + PERF_IDLE_GAP_MS + 1 + 200 + PERF_IDLE_GAP_MS); // exactly the gap: folds
    expect(rig.samples.at(-1)?.frameIntervalMs).toBeCloseTo(
      200 + PERF_EMA_ALPHA * (PERF_IDLE_GAP_MS - 200),
      12,
    );
  });

  it("setActive(true) re-arms the throttle + EMA so a re-opened HUD samples at once", async () => {
    const rig = makeRig();
    await rig.paintAt(0);
    await rig.paintAt(50); // inside the throttle window: no GPU sample
    expect(rig.samples).toHaveLength(1);
    rig.sampler.setActive(true);
    expect(rig.sampler.isActive()).toBe(true);
    await rig.paintAt(60);
    expect(rig.samples).toHaveLength(2);
    expect(rig.samples[1]?.frameIntervalMs).toBeNaN(); // the 10 ms since the last paint was forgotten
    rig.sampler.setActive(false);
    expect(rig.sampler.isActive()).toBe(false);
  });

  it("paintTimed brackets the frame and posts its frameTiming, plus a HUD sample while active", async () => {
    const rig = makeRig();
    await rig.paintAt(0);
    rig.samples.length = 0;
    rig.timer.beginFrame.mockClear();
    rig.sampler.paintTimed(rig.paint);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(rig.timer.beginFrame).toHaveBeenCalledTimes(1);
    expect(rig.paint).toHaveBeenCalledTimes(2);
    expect(rig.timings).toEqual([{ kind: "frameTiming", gpuTimeMs: GPU_MS, clock: "wallclock" }]);
    expect(rig.samples).toHaveLength(0); // HUD closed: no perf sample
    // The timer rejects an in-flight read with NaN: nothing is posted for that frame.
    rig.timer.sampleAfterSubmit.mockResolvedValueOnce(Number.NaN);
    rig.sampler.paintTimed(rig.paint);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(rig.timings).toHaveLength(1);
    // With the HUD open the same measurement also rides as a continuous perf sample.
    rig.sampler.setActive(true);
    rig.sampler.paintTimed(rig.paint);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(rig.timings).toHaveLength(2);
    expect(rig.samples).toHaveLength(1);
    expect(rig.samples[0]).toMatchObject({ frameWallMs: GPU_MS, isContinuous: true });
  });

  it("posts the continuous path's sample only while active", () => {
    const rig = makeRig();
    rig.sampler.postContinuousSample(12.5);
    expect(rig.samples).toHaveLength(0);
    rig.sampler.setActive(true);
    rig.sampler.postContinuousSample(12.5);
    expect(rig.samples[0]).toMatchObject({ frameWallMs: 12.5, isContinuous: true });
    expect(rig.samples[0]?.cpuEncodeMs).toBeNaN();
    expect(rig.samples[0]?.frameIntervalMs).toBeNaN();
  });

  it("rides without a frame timer (GPU field NaN) and reports a failed sample instead of throwing", async () => {
    const noTimer = makeRig({ timer: false });
    await noTimer.paintAt(0);
    expect(noTimer.samples[0]?.frameWallMs).toBeNaN();

    const rig = makeRig();
    rig.timer.sampleAfterSubmit.mockRejectedValueOnce(new Error("device lost"));
    await rig.paintAt(0);
    expect(rig.samples).toHaveLength(0);
    expect(rig.reportFault).toHaveBeenCalledWith(
      expect.objectContaining({ message: "device lost" }),
    );
  });
});
