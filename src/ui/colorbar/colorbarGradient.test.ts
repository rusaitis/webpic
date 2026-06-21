import { describe, expect, it } from "vitest";
import { makeScale } from "../controls/rangeMath.ts";
import { type ColorbarTick, formatTicks, formatValue, tickLabels } from "./colorbarGradient.ts";

const values = (ticks: ColorbarTick[]): number[] => ticks.map((tk) => Number(tk.label));

describe("tickLabels", () => {
  it("places nice round ticks across a linear window", () => {
    const ticks = tickLabels({ center: 5.5, width: 1 }, "linear", 5); // [5, 6]
    expect(ticks.map((t) => t.label)).toEqual(["5.0", "5.2", "5.4", "5.6", "5.8", "6.0"]);
    expect(ticks[0]?.t).toBeCloseTo(0, 9);
    expect(ticks.at(-1)?.t).toBeCloseTo(1, 9);
  });

  it("guarantees an exact 0 tick for a signed window", () => {
    const ticks = tickLabels({ center: 2, width: 10 }, "linear", 5); // [-3, 7]
    const zero = ticks.find((t) => Number(t.label) === 0);
    expect(zero).toBeDefined();
    expect(zero?.t).toBeCloseTo(makeScale("linear", -3, 7).toT(0), 9); // 0.3
  });

  it("labels decade values on a log window", () => {
    const ticks = tickLabels({ center: 55, width: 90 }, "log", 5); // [10, 100]
    expect(ticks.map((t) => t.label)).toEqual(["10", "100"]);
    expect(ticks[0]?.t).toBeCloseTo(0, 9);
    expect(ticks.at(-1)?.t).toBeCloseTo(1, 9);
  });

  it("centers 0 and places decades symmetrically on a symlog window", () => {
    const ticks = tickLabels({ center: 0, width: 200 }, "symlog", 5); // [-100, 100]
    expect(ticks.some((t) => t.label === "0")).toBe(true);
    expect(ticks.find((t) => t.label === "0")?.t).toBeCloseTo(0.5, 9);
    const pos = ticks.find((t) => Number(t.label) === 1);
    const neg = ticks.find((t) => Number(t.label) === -1);
    expect(pos).toBeDefined();
    expect(neg).toBeDefined();
    expect((pos?.t ?? 0) + (neg?.t ?? 0)).toBeCloseTo(1, 6); // symmetric about the center
  });

  it("thins a many-decade symlog ruler instead of blanking it", () => {
    const ticks = tickLabels({ center: 0, width: 2e6 }, "symlog", 5); // [-1e6, 1e6]
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks.some((t) => t.label === "0")).toBe(true);
  });

  it("falls back to a linear read when a log window reaches ≤ 0", () => {
    // makeScale('log', …) throws on min ≤ 0; tickLabels must not.
    expect(() => tickLabels({ center: 0, width: 2 }, "log", 3)).not.toThrow();
    expect(values(tickLabels({ center: 0, width: 2 }, "log", 3))).toEqual([-1, 0, 1]);
  });
});

describe("formatTicks", () => {
  it("uses one decimal count across the set (clean, no FP tails)", () => {
    expect(formatTicks([0, 0.2, 0.4, 0.6], 0.2)).toEqual(["0.0", "0.2", "0.4", "0.6"]);
  });

  it("falls back to uniform exponential for extreme magnitudes; 0 stays bare", () => {
    expect(formatTicks([0, 1e8, 2e8], 1e8)).toEqual(["0", "1.00e+8", "2.00e+8"]);
  });

  it("normalizes -0 to 0", () => {
    expect(formatTicks([-0, 0.5], 0.5)).toEqual(["0.0", "0.5"]);
  });
});

describe("formatValue", () => {
  it("uses exponential for very small / large magnitudes", () => {
    expect(formatValue(1.2e-4)).toBe("1.20e-4");
    expect(formatValue(50000)).toBe("5.00e+4");
  });

  it("uses ~4 significant figures otherwise", () => {
    expect(formatValue(5.25)).toBe("5.25");
    expect(formatValue(0)).toBe("0");
  });
});
