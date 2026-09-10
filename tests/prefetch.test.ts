import { createScrubPredictor } from "@data/prefetch.ts";
import { createStreamRing } from "@data/stream.ts";
import { describe, expect, it } from "vitest";
import { seededRandom } from "./helpers.ts";

// The directional predictor (data/prefetch.ts) is pure with injected time, so motion is scripted by
// (step, nowMs) pairs and `plan()` inspected directly — no clock, no flake. The fuzz scrubber proves
// the in-domain / dedup / bounded / always-contains-cursor invariants hold for *any* scrub, and the
// integration test drives the real ring with `plan` to show the "scrub without stalls" contract survives.

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const clampToDomain = (x: number, n: number): number => Math.max(0, Math.min(n - 1, x));

describe("createScrubPredictor", () => {
  it("starts stationary → symmetric ±1 (identical to the dumb policy)", () => {
    const p = createScrubPredictor({ steps: range(20) });
    p.observe(10, 0); // first sample only establishes the origin — no committed direction yet
    expect(sorted(p.plan(10))).toEqual([9, 10, 11]);
  });

  it("a slow steady ±1 scrub stays symmetric ±1 (no regression vs the dumb policy)", () => {
    const p = createScrubPredictor({ steps: range(20) });
    let t = 0;
    for (let step = 5; step <= 9; step++) {
      t += 100;
      p.observe(step, t);
    }
    // count = mean|delta| = 1 → the forward bias collapses back to {c−1, c, c+1}
    expect(sorted(p.plan(9))).toEqual([8, 9, 10]);
  });

  it("a sustained fast forward scrub biases the window ahead, count grows with speed", () => {
    const p = createScrubPredictor({ steps: range(40) });
    let t = 0;
    let s = 0;
    for (let i = 0; i < 6; i++) {
      s += 3; // Δ = +3 each tick
      t += 100;
      p.observe(s, t);
    }
    // committed +1, count ≈ 3 → {c−1 (trailing), c, c+1, c+2, c+3}
    expect(sorted(p.plan(s))).toEqual([s - 1, s, s + 1, s + 2, s + 3]);
  });

  it("maps speed magnitude to a prefetch count capped at 5", () => {
    const p = createScrubPredictor({ steps: range(100) });
    let t = 0;
    let s = 0;
    for (let i = 0; i < 8; i++) {
      s += 10; // very fast — mean speed 10 → count clamps to 5
      t += 100;
      p.observe(s, t);
    }
    const plan = p.plan(s);
    expect(plan.length).toBe(7); // 5 forward + center + 1 trailing
    expect(plan.length).toBeLessThanOrEqual(5 + 2);
  });

  it("clamps the forward bias at the domain end", () => {
    const p = createScrubPredictor({ steps: range(10) });
    let t = 0;
    let s = 0;
    for (let i = 0; i < 3; i++) {
      s += 3;
      t += 100;
      p.observe(s, t); // s ends at 9, the last index
    }
    const plan = sorted(p.plan(9));
    expect(plan.every((x) => x >= 0 && x < 10)).toBe(true);
    expect(plan).toContain(9);
    expect(Math.max(...plan)).toBe(9); // nothing prefetched past the end
  });

  it("holds the forward window through a reversal shorter than the 250 ms debounce", () => {
    const p = createScrubPredictor({ steps: range(60) });
    let t = 0;
    let s = 0;
    for (let i = 0; i < 6; i++) {
      s += 3;
      t += 100;
      p.observe(s, t); // commit +1 around s = 18, t = 600
    }
    p.observe(s - 3, 700); // first reversal sample, +100 ms < 250 → not yet flipped
    const plan = p.plan(s - 3);
    expect(plan).toContain(s - 3 + 1); // forward neighbour still wanted
    expect(Math.max(...plan)).toBeGreaterThan(s - 3); // window still reaches forward
  });

  it("flips the window once a reversal persists past the 250 ms debounce", () => {
    const p = createScrubPredictor({ steps: range(60) });
    let t = 0;
    let s = 0;
    for (let i = 0; i < 6; i++) {
      s += 3;
      t += 100;
      p.observe(s, t); // commit +1, s = 18, t = 600
    }
    p.observe(s - 3, 700); // reversal starts
    p.observe(s - 6, 1000); // 300 ms later (≥ 250) → commit −1
    const plan = sorted(p.plan(s - 6));
    expect(Math.min(...plan)).toBeLessThan(s - 6); // now biased backward
  });

  it("reverts to symmetric ±1 after 2 s of stationarity", () => {
    const p = createScrubPredictor({ steps: range(40) });
    let t = 0;
    let s = 0;
    for (let i = 0; i < 6; i++) {
      s += 3;
      t += 100;
      p.observe(s, t); // committed +1
    }
    p.observe(s + 3, t + 5000); // idle gap ≥ 2 s → reset; this sample re-establishes the origin
    expect(sorted(p.plan(s + 3))).toEqual([s + 2, s + 3, s + 4]);
  });

  it("biases in index space over a sparse (non-contiguous) domain", () => {
    const steps = [0, 5, 10, 15, 20, 25, 30]; // stride-5 domain
    const p = createScrubPredictor({ steps });
    let t = 0;
    for (const step of [0, 5, 10, 15]) {
      t += 100;
      p.observe(step, t); // Δindex = +1 → count 1
    }
    // forward by one *index*, not one step value: {10, 15, 20}
    expect(sorted(p.plan(15))).toEqual([10, 15, 20]);
  });

  describe("fuzz scrubber", () => {
    it("plan stays in-domain, contains the cursor, deduped and bounded — for any scrub", () => {
      const steps = range(64);
      const domain = new Set(steps);
      for (let seed = 1; seed <= 40; seed++) {
        const rand = seededRandom(seed);
        const p = createScrubPredictor({ steps });
        let t = 0;
        let cur = Math.floor(rand() * 64);
        for (let step = 0; step < 200; step++) {
          cur = clampToDomain(cur + (Math.floor(rand() * 13) - 6), 64); // jump within [−6, +6]
          t += rand() < 0.1 ? 3000 : Math.floor(rand() * 200); // 10 % idle gaps cross STATIONARY_MS
          p.observe(cur, t);
          const plan = p.plan(cur);
          expect(plan).toContain(cur); // the cursor is always wanted
          expect(new Set(plan).size).toBe(plan.length); // no duplicates
          expect(plan.length).toBeLessThanOrEqual(5 + 2); // bounded by count + center + trailing
          for (const x of plan) expect(domain.has(x)).toBe(true); // never out of domain
        }
      }
    });
  });

  describe("ring + predictor integration", () => {
    it("a fuzzed scrub still displays the settled cursor with no errors (scrub without stalls)", async () => {
      const steps = range(40);
      const domain = new Set(steps);
      const rand = seededRandom(7);
      const predictor = createScrubPredictor({ steps });
      const displayed: number[] = [];
      const errors: unknown[] = [];
      const reads = new Map<number, (value: number) => void>();
      const ring = createStreamRing<number>({
        steps,
        readStep: (step) => new Promise<number>((resolve) => reads.set(step, resolve)),
        onDisplay: (step) => displayed.push(step),
        onError: (_step, error) => errors.push(error),
        capacity: 7, // MAX_COUNT + 2 — so the farthest-ahead prefetch isn't evicted first
        plan: (center) => predictor.plan(center),
      });
      let t = 0;
      let cur = 20;
      for (let i = 0; i < 80; i++) {
        cur = clampToDomain(cur + (Math.floor(rand() * 7) - 3), 40); // jump within [−3, +3]
        t += Math.floor(rand() * 150);
        predictor.observe(cur, t);
        ring.setCursor(cur);
        for (const [step, resolve] of [...reads]) {
          reads.delete(step);
          resolve(step); // settle every in-flight read this tick
        }
        await tick();
      }
      expect(displayed.at(-1)).toBe(cur); // the final settled cursor displayed
      expect(errors).toEqual([]); // no spurious read failures
      for (const step of ring.pending()) expect(domain.has(step)).toBe(true); // pending all in-domain
      ring.dispose();
    });
  });
});
