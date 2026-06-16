import { describe, expect, it } from "vitest";
import { createFrameTimer } from "./frameTimer.ts";

// Minimal stub — the wall-clock timer only calls queue.onSubmittedWorkDone. Cast through unknown:
// a full GPUDevice is unavailable in node, and we exercise exactly the one method the timer touches.
function stubDevice(
  onSubmittedWorkDone: () => Promise<undefined> = async () => undefined,
): GPUDevice {
  return { queue: { onSubmittedWorkDone } } as unknown as GPUDevice;
}

describe("createFrameTimer", () => {
  it("is always wall-clock (render-pass timestamps are removed)", () => {
    expect(createFrameTimer(stubDevice()).mode).toBe("wallclock");
  });

  it("brackets the submit and returns a finite elapsed time", async () => {
    const timer = createFrameTimer(stubDevice());
    timer.beginFrame();
    const ms = await timer.sampleAfterSubmit();
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("skips a sample (NaN) while a prior read is still in flight", async () => {
    let release: () => void = () => {};
    const device = stubDevice(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const timer = createFrameTimer(device);
    timer.beginFrame();
    const first = timer.sampleAfterSubmit(); // holds the lock until released
    expect(await timer.sampleAfterSubmit()).toBeNaN(); // re-entrant call is skipped
    release();
    expect(Number.isFinite(await first)).toBe(true);
  });
});
