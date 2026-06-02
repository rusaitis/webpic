import { describe, expect, it } from "vitest";
import {
  clamp,
  clampInterval,
  intervalToWindow,
  makeScale,
  minorTickPositions,
  pointerT,
  snapToDecade,
  snapToStep,
  stepDecade,
  tickPositions,
  translateInterval,
  windowToInterval,
} from "./rangeMath.ts";

describe("snapToStep", () => {
  it("snaps a dragged value to the step grid (aligned to min)", () => {
    expect(snapToStep(7.26, 0, 20, 0.5)).toBeCloseTo(7.5, 9);
    expect(snapToStep(-3.14, -1000, 1000, 0.1)).toBeCloseTo(-3.1, 9);
  });

  it("clamps to [min, max]", () => {
    expect(snapToStep(999, 0, 20, 1)).toBe(20);
    expect(snapToStep(-5, 0, 20, 1)).toBe(0);
  });

  it("with no (or non-positive) step, clamps only — the precise-text override path", () => {
    expect(snapToStep(7.263541, 0, 20)).toBeCloseTo(7.263541, 9);
    expect(snapToStep(7.263541, 0, 20, 0)).toBeCloseTo(7.263541, 9);
  });
});

describe("snapToDecade (log/symlog drag grid)", () => {
  const min = -1000;
  const max = 1000;

  it("snaps to ten divisions per decade, the step scaling with magnitude", () => {
    expect(snapToDecade(0.23, min, max)).toBeCloseTo(0.2, 9); // [0.1,1) → step 0.1
    expect(snapToDecade(3.4, min, max)).toBeCloseTo(3, 9); //   [1,10)   → step 1
    expect(snapToDecade(47, min, max)).toBeCloseTo(50, 9); //   [10,100) → step 10
    expect(snapToDecade(231, min, max)).toBeCloseTo(200, 9); // [100,1k) → step 100
  });

  it("is symmetric about zero", () => {
    expect(snapToDecade(-47, min, max)).toBeCloseTo(-50, 9);
    expect(snapToDecade(-231, min, max)).toBeCloseTo(-200, 9);
  });

  it("lands exactly on powers of ten (no log10 round-off drift)", () => {
    for (const p of [0.1, 1, 10, 100, 1000]) expect(snapToDecade(p, min, max)).toBeCloseTo(p, 9);
  });

  it("floors granularity at minStep, rounding sub-minStep magnitudes to 0", () => {
    expect(snapToDecade(0.3, min, max, 1)).toBe(0); // below the floored half-step → 0
    expect(snapToDecade(0.7, min, max, 1)).toBe(1); // floored decade step = 1
    expect(snapToDecade(3.4, min, max, 1)).toBe(3); // above the floor → normal decade
  });

  it("clamps to range", () => {
    expect(snapToDecade(99999, min, max)).toBe(1000);
    expect(snapToDecade(-99999, min, max)).toBe(-1000);
  });
});

describe("stepDecade (log/symlog keyboard grid)", () => {
  const min = -1000;
  const max = 1000;

  it("moves one grid cell, the step magnitude-aware", () => {
    expect(stepDecade(20, 1, min, max)).toBe(30);
    expect(stepDecade(20, -1, min, max)).toBe(10);
    expect(stepDecade(100, 1, min, max)).toBe(200);
  });

  it("drops to the finer decade stepping toward zero off a power of ten", () => {
    expect(stepDecade(10, -1, min, max)).toBe(9);
    expect(stepDecade(100, -1, min, max)).toBe(90);
    expect(stepDecade(-10, 1, min, max)).toBe(-9); // toward zero from the negative side
  });

  it("keeps full decade steps moving away from zero (no finer drop)", () => {
    expect(stepDecade(-10, -1, min, max)).toBe(-20);
  });

  it("crosses zero cleanly through the minStep floor", () => {
    expect(stepDecade(1, -1, min, max, 1)).toBe(0);
    expect(stepDecade(0, -1, min, max, 1)).toBe(-1);
    expect(stepDecade(0, 1, min, max, 1)).toBe(1);
  });
});

describe("pointerT", () => {
  it("maps pointer x to a clamped [0, 1] across the track", () => {
    const rect = { left: 100, width: 200 };
    expect(pointerT(200, rect)).toBeCloseTo(0.5, 9);
    expect(pointerT(50, rect)).toBe(0); // left of track
    expect(pointerT(400, rect)).toBe(1); // right of track
  });

  it("degenerates safely on a zero-width track", () => {
    expect(pointerT(123, { left: 0, width: 0 })).toBe(0);
  });
});

describe("makeScale: linear", () => {
  const s = makeScale("linear", -10, 30);
  it("hits the endpoints", () => {
    expect(s.toT(-10)).toBe(0);
    expect(s.toT(30)).toBe(1);
  });
  it("round-trips toValue(toT(v)) ≈ v", () => {
    for (const v of [-10, -3, 0, 7.5, 30]) expect(s.toValue(s.toT(v))).toBeCloseTo(v, 9);
  });
});

describe("makeScale: log", () => {
  it("throws on a non-positive minimum", () => {
    expect(() => makeScale("log", 0, 100)).toThrow(/min > 0/);
    expect(() => makeScale("log", -1, 100)).toThrow();
  });
  const s = makeScale("log", 1, 1000);
  it("places decades evenly and hits the endpoints", () => {
    expect(s.toT(1)).toBe(0);
    expect(s.toT(1000)).toBe(1);
    expect(s.toT(10)).toBeCloseTo(1 / 3, 6);
    expect(s.toT(100)).toBeCloseTo(2 / 3, 6);
  });
  it("round-trips", () => {
    for (const v of [1, 5, 42, 1000]) expect(s.toValue(s.toT(v))).toBeCloseTo(v, 6);
  });
});

describe("makeScale: symlog (the B-field case)", () => {
  const min = -1000;
  const max = 1000;
  const L = 20;
  const s = makeScale("symlog", min, max, { linthresh: L });

  it("reports its linear threshold and centers 0 for a symmetric range", () => {
    expect(s.linthresh).toBe(L);
    expect(s.toT(0)).toBeCloseTo(0.5, 9);
    expect(s.toT(min)).toBe(0);
    expect(s.toT(max)).toBe(1);
  });

  it("is linear inside ±L (equal value steps ⇒ equal position steps)", () => {
    const d1 = s.toT(10) - s.toT(0);
    const d2 = s.toT(20) - s.toT(10);
    expect(d1).toBeCloseTo(d2, 9);
  });

  it("compresses the tails (per-unit resolution near 0 ≫ in the tail)", () => {
    const nearZeroPerUnit = (s.toT(L) - s.toT(0)) / L; // 0..20
    const tailPerUnit = (s.toT(max) - s.toT(L)) / (max - L); // 20..1000
    expect(nearZeroPerUnit).toBeGreaterThan(tailPerUnit * 5);
  });

  it("round-trips across band and tails", () => {
    for (const v of [-1000, -300, -20, -5, 0, 5, 20, 300, 1000]) {
      expect(s.toValue(s.toT(v))).toBeCloseTo(v, 6);
    }
  });

  it("defaults linthresh to maxAbs/100 when unset", () => {
    expect(makeScale("symlog", -500, 500).linthresh).toBeCloseTo(5, 9);
  });
});

describe("tickPositions", () => {
  it("linear: even marks gated to 2..24 intervals", () => {
    const s = makeScale("linear", 32, 256);
    expect(tickPositions(s, { step: 32 })).toHaveLength(8); // 7 intervals → 8 marks
    expect(tickPositions(s, { step: 0.01 })).toEqual([]); // too fine → solid bar
  });

  it("symlog: power-of-ten marks plus 0, all within range (no ±linthresh)", () => {
    const s = makeScale("symlog", -1000, 1000, { linthresh: 20 });
    const ts = tickPositions(s);
    expect(ts).toHaveLength(7);
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBe(1);
    expect(ts).toContain(0.5);
    expect(ts.map((t) => Math.round(s.toValue(t)))).toEqual([-1000, -100, -10, 0, 10, 100, 1000]);
  });
});

describe("minorTickPositions (log/symlog sub-decade marks)", () => {
  it("is empty for linear scales", () => {
    expect(minorTickPositions(makeScale("linear", 0, 100))).toEqual([]);
  });

  it("emits 2..9 per decade for a log scale, within range and off the majors", () => {
    const s = makeScale("log", 1, 100); // decades 10⁰, 10¹ → 8 + 8
    const ts = minorTickPositions(s);
    expect(ts).toHaveLength(16);
    for (const t of ts) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });

  it("places symlog minors on both tails, skipping the linear band", () => {
    const s = makeScale("symlog", -1000, 1000, { linthresh: 10 });
    const ts = minorTickPositions(s);
    expect(ts.some((t) => t < 0.5)).toBe(true); // negative tail
    expect(ts.some((t) => t > 0.5)).toBe(true); // positive tail
    for (const t of ts) expect(Math.abs(s.toValue(t))).toBeGreaterThanOrEqual(10 - 1e-6);
  });

  it("declutters to [] once the tail spans more than 3 decades", () => {
    expect(minorTickPositions(makeScale("log", 1, 1e5))).toEqual([]);
  });

  it("clamps minors to [min, max]", () => {
    const s = makeScale("log", 1, 30); // top minors 40..90 exceed max
    const vals = minorTickPositions(s).map((t) => Math.round(s.toValue(t)));
    expect(Math.max(...vals)).toBeLessThanOrEqual(30);
  });
});

describe("interval helpers", () => {
  it("clampInterval keeps order, bounds, and a minimum gap", () => {
    expect(clampInterval(8, 2, 0, 10)).toEqual([2, 8]); // reorders
    expect(clampInterval(-5, 99, 0, 10)).toEqual([0, 10]); // bounds
    expect(clampInterval(5, 5, 0, 10, 2)).toEqual([5, 7]); // grow the gap upward when there's room
    expect(clampInterval(10, 10, 0, 10, 2)).toEqual([8, 10]); // pull lo down at the max edge
  });

  it("translateInterval moves both ends and stops at the wall", () => {
    expect(translateInterval(2, 6, 3, 0, 10)).toEqual([5, 9]);
    expect(translateInterval(2, 6, 100, 0, 10)).toEqual([6, 10]); // clamped: width preserved
    expect(translateInterval(2, 6, -100, 0, 10)).toEqual([0, 4]);
  });
});

describe("window/level conversions", () => {
  it("intervalToWindow maps [lo, hi] → {center, width}", () => {
    expect(intervalToWindow(2, 8)).toEqual({ center: 5, width: 6 });
    expect(intervalToWindow(-4, 4)).toEqual({ center: 0, width: 8 });
  });

  it("windowToInterval is its inverse", () => {
    for (const [lo, hi] of [
      [0, 1],
      [-3, 7],
      [12.5, 88.5],
    ] as const) {
      const [lo2, hi2] = windowToInterval(intervalToWindow(lo, hi));
      expect(lo2).toBeCloseTo(lo, 9);
      expect(hi2).toBeCloseTo(hi, 9);
    }
  });
});

describe("clamp", () => {
  it("bounds a value", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
