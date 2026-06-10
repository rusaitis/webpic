import { describe, expect, it } from "vitest";
import { niceTicks } from "./niceTicks.ts";

describe("niceTicks", () => {
  it("snaps a voxel-extent range to a round step (the synthetic 256³ default)", () => {
    const { step, ticks, decimals } = niceTicks(0, 256, 8);
    expect(step).toBe(50);
    expect(ticks).toEqual([0, 50, 100, 150, 200, 250]); // 300 excluded — clipped to [0,256]
    expect(decimals).toBe(0);
  });

  it("uses fractional steps with the right precision", () => {
    const { step, ticks, decimals } = niceTicks(0, 1, 5);
    expect(step).toBe(0.2);
    expect(ticks).toHaveLength(6);
    expect(ticks.at(-1)).toBeCloseTo(1, 12);
    expect(decimals).toBe(1);
  });

  it("spans a symmetric signed range on integer ticks", () => {
    const { step, ticks } = niceTicks(-3, 3, 6);
    expect(step).toBe(1);
    expect(ticks).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });

  it("handles a negative-only range", () => {
    const { step, ticks } = niceTicks(-100, -10, 5);
    expect(step).toBe(20);
    expect(ticks).toEqual([-100, -80, -60, -40, -20]);
  });

  it("scales to tiny and huge magnitudes", () => {
    const tiny = niceTicks(0, 1e-6, 5);
    expect(tiny.step).toBeCloseTo(2e-7, 18);
    expect(tiny.decimals).toBe(7);

    const huge = niceTicks(0, 5e9, 5);
    expect(huge.step).toBe(1e9);
    expect(huge.ticks).toEqual([0, 1e9, 2e9, 3e9, 4e9, 5e9]);
    expect(huge.decimals).toBe(0);
  });

  it("normalizes an inverted range", () => {
    expect(niceTicks(5, 1, 4).ticks).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns a single degenerate tick for a zero-width range (no divide-by-zero)", () => {
    expect(niceTicks(7, 7, 5)).toEqual({ step: 0, ticks: [7], decimals: 0 });
  });

  it("never exceeds the runaway tick cap", () => {
    expect(niceTicks(0, 1e9, 1).ticks.length).toBeLessThanOrEqual(1000);
  });
});
