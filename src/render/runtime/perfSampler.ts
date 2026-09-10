import type { VramSnapshot } from "@gpu";
import type { RenderWorkerResponse } from "../messages.ts";
import type { FrameTimer } from "./frameTimer.ts";

// The timing samples the worker posts off painted frames. Continuous render timing (paintTimed)
// brackets every frame with the GPU timer. Dev perf HUD sampling (paintPerf) is dormant until
// setActive(true): the CPU-encode bracket + painted-frame interval EMA cost ~nothing per frame; the
// GPU wall-clock sync (onSubmittedWorkDone) is throttled to PERF_GPU_SAMPLE_MS so it can't perturb a
// sustained gesture, and only ever rides frames already painting — it never forces one
// (renderLoop.setPerfActive deliberately doesn't re-dirty).
export const PERF_GPU_SAMPLE_MS = 200; // ≤5 Hz GPU sync
export const PERF_EMA_ALPHA = 0.2; // painted-frame interval smoothing
export const PERF_IDLE_GAP_MS = 500; // a longer gap means we resumed after idle — don't fold it into the EMA
export const VRAM_TOP_N = 5; // largest tracked allocations surfaced in the HUD detail panel

export type PerfSampleMessage = Extract<RenderWorkerResponse, { kind: "perfSample" }>;
export type FrameTimingMessage = Extract<RenderWorkerResponse, { kind: "frameTiming" }>;

export interface PerfSamplerHost {
  /** The live per-frame timer; undefined pre-init / post-dispose (the GPU field rides as NaN). */
  frameTimer(): FrameTimer | undefined;
  /** The frame-time governor's render-scale ceiling, surfaced in every sample. */
  governorScale(): number;
  vramSnapshot(): VramSnapshot;
  readHeapBytes(): number | null;
  post(sample: PerfSampleMessage | FrameTimingMessage): void;
  reportFault(error: unknown): void;
  /** Wall clock in ms — performance.now unless a test injects one. */
  readonly now?: () => number;
}

export interface PerfSampler {
  /** Gate sampling. Enabling resets the interval EMA + GPU throttle so a re-open neither folds the
   *  idle gap into the EMA nor fires the GPU sync on the stale clock. */
  setActive(active: boolean): void;
  isActive(): boolean;
  /** Paint one continuous-mode frame through `paint` with the GPU timer bracketed around it, and post
   *  its frameTiming (fire-and-forget: the read is async and NaNs for a sample the timer rejects). */
  paintTimed(paint: () => void): void;
  /** Paint one on-demand frame through `paint`, bracketed by the cheap CPU-encode timing + interval
   *  EMA, with the throttled GPU wall-clock sample when one is due. */
  paintPerf(paint: () => void): void;
  /** A frame the continuous path already measured on the shared wall clock: post it as a HUD sample
   *  (CPU-encode + interval aren't measured there and ride as NaN). No-op while inactive. */
  postContinuousSample(gpuTimeMs: number): void;
}

export function createPerfSampler(host: PerfSamplerHost): PerfSampler {
  const now = host.now ?? (() => performance.now());
  let active = false;
  let lastPaintMs = Number.NaN;
  let frameIntervalEma = Number.NaN;
  let lastGpuSampleMs = Number.NaN;

  // vram + heap are read here (both cheap); the timing fields differ between the on-demand perf path
  // and the continuous timing path, so the caller supplies them.
  function postSample(
    cpuEncodeMs: number,
    frameWallMs: number,
    frameIntervalMs: number,
    isContinuous: boolean,
  ): void {
    const vram = host.vramSnapshot();
    host.post({
      kind: "perfSample",
      cpuEncodeMs,
      frameWallMs,
      frameIntervalMs,
      isContinuous,
      governorScale: host.governorScale(),
      vramBytes: vram.totalBytes,
      vramByKey: vram.byKey.slice(0, VRAM_TOP_N), // tiny: structured-cloned, not transferred
      workerHeapBytes: host.readHeapBytes(),
    });
  }

  // The on-demand path's GPU sample: await the throttled wall-clock (NaN if the timer is absent or a
  // read is already in flight — the HUD's rolling mean skips those).
  async function sampleGpu(cpuEncodeMs: number, frameIntervalMs: number): Promise<void> {
    const timer = host.frameTimer();
    const frameWallMs = timer === undefined ? Number.NaN : await timer.sampleAfterSubmit();
    postSample(cpuEncodeMs, frameWallMs, frameIntervalMs, false);
  }

  // The continuous path's read: skip an in-flight/rejected sample rather than back up the loop.
  async function sampleTiming(): Promise<void> {
    const timer = host.frameTimer();
    if (timer === undefined) return;
    const gpuTimeMs = await timer.sampleAfterSubmit();
    if (Number.isNaN(gpuTimeMs)) return;
    host.post({ kind: "frameTiming", gpuTimeMs, clock: timer.mode });
    postContinuousSample(gpuTimeMs);
  }

  // A HUD open alongside continuous timing reads the same wall-clock.
  function postContinuousSample(gpuTimeMs: number): void {
    if (active) postSample(Number.NaN, gpuTimeMs, Number.NaN, true);
  }

  return {
    setActive(on) {
      active = on;
      if (on) {
        lastPaintMs = Number.NaN;
        frameIntervalEma = Number.NaN;
        lastGpuSampleMs = Number.NaN;
      }
    },
    isActive: () => active,
    paintTimed(paint) {
      host.frameTimer()?.beginFrame();
      paint();
      void sampleTiming().catch(host.reportFault);
    },
    paintPerf(paint) {
      const startMs = now();
      if (!Number.isNaN(lastPaintMs)) {
        const interval = startMs - lastPaintMs;
        // A long gap means the on-demand loop was idle and just resumed — don't fold it into the EMA.
        frameIntervalEma =
          interval > PERF_IDLE_GAP_MS
            ? Number.NaN
            : Number.isNaN(frameIntervalEma)
              ? interval
              : frameIntervalEma + PERF_EMA_ALPHA * (interval - frameIntervalEma);
      }
      lastPaintMs = startMs;
      // The cheap CPU-encode bracket + interval EMA ride every painted frame; throttle only the GPU
      // wall-clock sync, and bracket the timer just for those frames so its measurement stays exact.
      const isGpuDue =
        Number.isNaN(lastGpuSampleMs) || startMs - lastGpuSampleMs >= PERF_GPU_SAMPLE_MS;
      if (isGpuDue) host.frameTimer()?.beginFrame();
      paint();
      if (isGpuDue) {
        lastGpuSampleMs = startMs;
        void sampleGpu(now() - startMs, frameIntervalEma).catch(host.reportFault);
      }
    },
    postContinuousSample,
  };
}
