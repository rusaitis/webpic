import { describe, expect, it } from "vitest";
import { nearestNiceStep, ticksForStep } from "./niceTicks.ts";

// overlayScene composes these two primitives: pick one step from the widest span (nearestNiceStep), then
// lay each axis on that step (ticksForStep). These cases drive the pair directly — the lattice and
// the spacing decision are tested where they live.
describe("grid tick lattice (nearestNiceStep + ticksForStep)", () => {
  it("snaps a voxel-extent range to a round step (the synthetic 256³ default)", () => {
    const step = nearestNiceStep(256, 8);
    expect(step).toBe(50);
    const { ticks, decimals } = ticksForStep(0, 256, step);
    expect(ticks).toEqual([0, 50, 100, 150, 200, 250]); // 300 excluded — clipped to [0,256]
    expect(decimals).toBe(0);
  });

  it("uses fractional steps with the right precision", () => {
    const step = nearestNiceStep(1, 5);
    expect(step).toBe(0.2);
    const { ticks, decimals } = ticksForStep(0, 1, step);
    expect(ticks).toHaveLength(6);
    expect(ticks.at(-1)).toBeCloseTo(1, 12);
    expect(decimals).toBe(1);
  });

  it("spans a symmetric signed range on integer ticks", () => {
    const step = nearestNiceStep(6, 6);
    expect(step).toBe(1);
    expect(ticksForStep(-3, 3, step).ticks).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });

  it("handles a negative-only range", () => {
    const step = nearestNiceStep(90, 5); // span = -10 − (-100)
    expect(step).toBe(20);
    expect(ticksForStep(-100, -10, step).ticks).toEqual([-100, -80, -60, -40, -20]);
  });

  it("scales to tiny and huge magnitudes", () => {
    const tinyStep = nearestNiceStep(1e-6, 5);
    expect(tinyStep).toBeCloseTo(2e-7, 18);
    expect(ticksForStep(0, 1e-6, tinyStep).decimals).toBe(7);

    const hugeStep = nearestNiceStep(5e9, 5);
    expect(hugeStep).toBe(1e9);
    const huge = ticksForStep(0, 5e9, hugeStep);
    expect(huge.ticks).toEqual([0, 1e9, 2e9, 3e9, 4e9, 5e9]);
    expect(huge.decimals).toBe(0);
  });

  it("normalizes an inverted range (ticksForStep sorts the bounds)", () => {
    expect(ticksForStep(5, 1, nearestNiceStep(4, 4)).ticks).toEqual([1, 2, 3, 4, 5]);
  });

  it("degenerates to a single tick for a zero-width range (no divide-by-zero)", () => {
    expect(nearestNiceStep(0, 5)).toBe(0); // span 0 → no step
    expect(ticksForStep(7, 7, 0)).toEqual({ ticks: [7], decimals: 0 });
  });

  it("never exceeds the runaway tick cap (tiny step over a huge range)", () => {
    expect(ticksForStep(0, 1e9, 1).ticks.length).toBeLessThanOrEqual(1000);
  });

  it("shares one step across unequal spans for uniform spacing (the dipole case)", () => {
    // x∈[-10,5] (span 15) drives the step; y∈[-5,5] (span 10) reuses it → both spaced 2 apart.
    const step = nearestNiceStep(Math.max(15, 10), 8);
    expect(step).toBe(2);
    expect(ticksForStep(-10, 5, step).ticks).toEqual([-10, -8, -6, -4, -2, 0, 2, 4]);
    expect(ticksForStep(-5, 5, step).ticks).toEqual([-4, -2, 0, 2, 4]);
  });

  it("degenerates to a single tick for a non-positive step or zero-width range", () => {
    expect(ticksForStep(0, 10, 0)).toEqual({ ticks: [0], decimals: 0 });
    expect(ticksForStep(7, 7, 2)).toEqual({ ticks: [7], decimals: 0 });
  });
});
