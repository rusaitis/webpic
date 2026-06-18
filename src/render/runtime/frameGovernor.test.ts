import { describe, expect, it } from "vitest";
import { createFrameGovernor, GOVERNOR_SCALES } from "./frameGovernor.ts";

// The control loop in isolation: feed synthetic frame intervals (ms) and read the render-scale tier.
// These pin the hysteresis contract — trip on sustained breach, recover slower, hold in the dead-band,
// reject spikes and idle gaps — without any renderer.

const FULL = GOVERNOR_SCALES[0] ?? 1;
const FLOOR = GOVERNOR_SCALES.at(-1) ?? 1;

// Feed `count` frames of `intervalMs`, returning how many of them flipped the tier.
function feed(
  gov: ReturnType<typeof createFrameGovernor>,
  intervalMs: number,
  count: number,
): number {
  let changes = 0;
  for (let i = 0; i < count; i++) if (gov.sample(intervalMs)) changes += 1;
  return changes;
}

describe("createFrameGovernor", () => {
  it("starts unthrottled at full scale", () => {
    expect(createFrameGovernor().scale()).toBe(FULL);
  });

  it("trips down one tier after a sustained breach, not before the dwell", () => {
    const gov = createFrameGovernor();
    // ~20 fps (50 ms) for under the trip dwell (1.5 s) must not act yet.
    feed(gov, 50, 20); // 1000 ms < 1500 ms
    expect(gov.scale()).toBe(FULL);
    // Cross the dwell and it steps down exactly once.
    const changes = feed(gov, 50, 20); // now well past 1500 ms total
    expect(changes).toBe(1);
    expect(gov.scale()).toBeLessThan(FULL);
    expect(gov.scale()).toBe(GOVERNOR_SCALES[1]);
  });

  it("clamps at the lowest tier under relentless slow frames", () => {
    const gov = createFrameGovernor();
    feed(gov, 60, 400); // ~16 fps for ~24 s — far past two trips
    expect(gov.scale()).toBe(FLOOR);
  });

  it("absorbs a lone spike without tripping (EWMA + dead-band)", () => {
    const gov = createFrameGovernor();
    for (let i = 0; i < 100; i++) gov.sample(i === 50 ? 200 : 16); // one 200 ms hitch in 60 fps
    expect(gov.scale()).toBe(FULL);
  });

  it("holds its tier when the rate parks in the dead-band (no hunting)", () => {
    const gov = createFrameGovernor();
    feed(gov, 50, 40); // ~2 s of 20 fps: one trip, to the second tier
    expect(gov.scale()).toBe(GOVERNOR_SCALES[1]);
    // 30 fps (33 ms) sits between recover (≈27 ms) and trip (≈42 ms): neither edge fires.
    const changes = feed(gov, 1000 / 30, 500);
    expect(changes).toBe(0);
    expect(gov.scale()).toBe(GOVERNOR_SCALES[1]);
  });

  it("recovers on sustained headroom — and slower than it tripped (asymmetric dwell)", () => {
    const gov = createFrameGovernor();
    feed(gov, 50, 80); // sink to the floor
    expect(gov.scale()).toBe(FLOOR);
    // A brief good burst (< recover dwell of 4 s) must not pop quality back up.
    feed(gov, 16, 30); // ~480 ms of 60 fps
    expect(gov.scale()).toBe(FLOOR);
    // Sustained 60 fps climbs back to full (two recover dwells).
    feed(gov, 16, 600); // ~9.6 s
    expect(gov.scale()).toBe(FULL);
  });

  it("drops idle gaps and forgets the stale trend so recovery stays clean", () => {
    const gov = createFrameGovernor();
    feed(gov, 50, 40); // throttle down a tier
    expect(gov.scale()).toBe(GOVERNOR_SCALES[1]);
    // A multi-second gap (the on-demand loop paused) is not one catastrophic frame — it must not
    // count toward another trip, and it clears the 50 ms trend.
    expect(gov.sample(5000)).toBe(false);
    feed(gov, 16, 600); // sustained 60 fps recovers all the way back, no lingering slow EWMA
    expect(gov.scale()).toBe(FULL);
  });

  it("ignores non-positive intervals", () => {
    const gov = createFrameGovernor();
    expect(gov.sample(0)).toBe(false);
    expect(gov.sample(-5)).toBe(false);
    expect(gov.scale()).toBe(FULL);
  });
});
