import { describe, expect, it } from "vitest";
import { niceStep, niceTicks, ticksForStep } from "./niceTicks.ts";

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

describe("niceStep / ticksForStep", () => {
  it("reproduces niceTicks when the step is derived from the same span", () => {
    const span = 256;
    const step = niceStep(span, 8);
    expect(step).toBe(50);
    expect({ step, ...ticksForStep(0, span, step) }).toEqual(niceTicks(0, span, 8));
  });

  it("shares one step across unequal spans for uniform spacing (the dipole case)", () => {
    // x∈[-10,5] (span 15) drives the step; y∈[-5,5] (span 10) reuses it → both spaced 2 apart.
    const step = niceStep(Math.max(15, 10), 8);
    expect(step).toBe(2);
    expect(ticksForStep(-10, 5, step).ticks).toEqual([-10, -8, -6, -4, -2, 0, 2, 4]);
    expect(ticksForStep(-5, 5, step).ticks).toEqual([-4, -2, 0, 2, 4]);
  });

  it("degenerates to a single tick for a non-positive step or zero-width range", () => {
    expect(ticksForStep(0, 10, 0)).toEqual({ ticks: [0], decimals: 0 });
    expect(ticksForStep(7, 7, 2)).toEqual({ ticks: [7], decimals: 0 });
  });
});
