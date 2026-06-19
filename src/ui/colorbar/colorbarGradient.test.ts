import { describe, expect, it } from "vitest";
import { makeScale } from "../controls/rangeMath.ts";
import { type ColorbarTick, formatValue, tickLabels } from "./colorbarGradient.ts";

const values = (ticks: ColorbarTick[]): number[] => ticks.map((tk) => Number(tk.label));

describe("tickLabels", () => {
  it("spans a linear window from min (t=0) to max (t=1)", () => {
    const ticks = tickLabels({ center: 5.5, width: 1 }, "linear", 5);
    expect(ticks.map((t) => t.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(values(ticks)).toEqual([5, 5.25, 5.5, 5.75, 6]);
  });

  it("matches the slider's log scale", () => {
    const window = { center: 55, width: 90 }; // [10, 100]
    const ticks = tickLabels(window, "log", 5);
    const scale = makeScale("log", 10, 100);
    for (const tk of ticks) {
      expect(Number(tk.label)).toBeCloseTo(Number(formatValue(scale.toValue(tk.t))), 6);
    }
    expect(Number(ticks[0]?.label)).toBeCloseTo(10, 6);
    expect(Number(ticks.at(-1)?.label)).toBeCloseTo(100, 6);
  });

  it("is symmetric about zero for a symlog window", () => {
    const ticks = tickLabels({ center: 0, width: 200 }, "symlog", 5); // [-100, 100]
    expect(Number(ticks[0]?.label)).toBeCloseTo(-100, 6);
    expect(Number(ticks[2]?.label)).toBeCloseTo(0, 6);
    expect(Number(ticks.at(-1)?.label)).toBeCloseTo(100, 6);
  });

  it("falls back to a linear read when a log window reaches ≤ 0", () => {
    // makeScale('log', …) throws on min ≤ 0; tickLabels must not.
    expect(() => tickLabels({ center: 0, width: 2 }, "log", 3)).not.toThrow();
    expect(values(tickLabels({ center: 0, width: 2 }, "log", 3))).toEqual([-1, 0, 1]);
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
