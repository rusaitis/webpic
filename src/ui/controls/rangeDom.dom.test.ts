import { describe, expect, it } from "vitest";
import { buildRangeDom, type RangeDomOptions } from "./rangeDom.ts";
import { makeScale } from "./rangeMath.ts";

const base = (overrides: Partial<RangeDomOptions> = {}): RangeDomOptions => ({
  min: 0,
  max: 10,
  isInterval: false,
  hasText: true,
  scale: makeScale("linear", 0, 10),
  origin: 0,
  hasMinorTicks: false,
  ...overrides,
});

const gripsOf = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLElement>(".webpic-range_grip")].map((g) => g.dataset.end ?? "");

describe("buildRangeDom", () => {
  it("builds one grip in single mode and two in interval mode", () => {
    expect(gripsOf(buildRangeDom(document, base()).root)).toEqual(["value"]);
    const interval = buildRangeDom(document, base({ isInterval: true }));
    expect(gripsOf(interval.root)).toEqual(["lo", "hi"]);
    expect(interval.root.dataset.mode).toBe("interval");
  });

  it("gives each grip the slider role and the value bounds, so it reads as one", () => {
    const { gripValue } = buildRangeDom(document, base({ min: -2, max: 8 }));
    expect(gripValue?.getAttribute("role")).toBe("slider");
    expect(gripValue?.getAttribute("aria-valuemin")).toBe("-2");
    expect(gripValue?.getAttribute("aria-valuemax")).toBe("8");
    expect(gripValue?.tabIndex).toBe(0); // focusable div, not an input — bare keys still reach the doc
  });

  it("pairs the text inputs with the mode", () => {
    expect(buildRangeDom(document, base()).inputB).toBeNull();
    expect(buildRangeDom(document, base({ isInterval: true })).inputB).not.toBeNull();
    expect(buildRangeDom(document, base({ hasText: false })).inputA).toBeNull();
  });

  it("paints no tick layer when ticks are off", () => {
    const { root } = buildRangeDom(document, base());
    expect(root.querySelector(".webpic-range_ticks")).toBeNull();
  });

  it("marks an interior fill origin even with ticks otherwise off", () => {
    const { root } = buildRangeDom(
      document,
      base({ min: -5, max: 5, origin: 0, scale: makeScale("linear", -5, 5) }),
    );
    const marks = root.querySelectorAll(".webpic-range_tick");
    expect(marks).toHaveLength(1);
    expect((marks[0] as HTMLElement).style.getPropertyValue("--mt")).toBe("0.5");
  });

  it("leaves an origin sitting on an endpoint unmarked — the track edge already shows it", () => {
    const { root } = buildRangeDom(document, base({ origin: 0 }));
    expect(root.querySelector(".webpic-range_tick")).toBeNull();
  });

  it("paints ticks above the fill so they stay visible over the colored range", () => {
    const { track } = buildRangeDom(
      document,
      base({ ticks: 4, min: -5, max: 5, scale: makeScale("linear", -5, 5) }),
    );
    const children = [...track.children].map((c) => c.className);
    expect(children.indexOf("webpic-range_fill")).toBeLessThan(
      children.indexOf("webpic-range_ticks"),
    );
  });

  it("adds minor ticks only on a log-ish scale that asked for them", () => {
    const scale = makeScale("log", 1, 1000);
    const withMinor = buildRangeDom(
      document,
      base({ min: 1, max: 1000, origin: 1, scale, ticks: true, hasMinorTicks: true }),
    );
    const without = buildRangeDom(
      document,
      base({ min: 1, max: 1000, origin: 1, scale, ticks: true, hasMinorTicks: false }),
    );
    expect(withMinor.root.querySelectorAll(".webpic-range_tick.is-minor").length).toBeGreaterThan(
      0,
    );
    expect(without.root.querySelectorAll(".webpic-range_tick.is-minor")).toHaveLength(0);
  });
});
