import { describe, expect, it } from "vitest";
import { createStreamRing, type StreamRingOptions } from "./stream.ts";

// The ring + prefetch orchestrator drives an injected async `readStep`; here a manually-resolved fake
// stands in (the value is just the step number), so each test controls decode timing and inspects
// residency/abort precisely — the "scrub without stalls" contract without any real I/O.

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Read {
  resolve: (value: number) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
}

function harness(steps: readonly number[], extra: Partial<StreamRingOptions<number>> = {}) {
  const reads = new Map<number, Read>(); // latest in-flight read per step
  const readStarts: number[] = []; // every read ever started (counts dedup / re-read)
  const displayed: Array<[number, number]> = [];
  const errors: Array<[number, unknown]> = [];
  const ring = createStreamRing<number>({
    steps,
    readStep: (step, signal) =>
      new Promise<number>((resolve, reject) => {
        readStarts.push(step);
        reads.set(step, { resolve, reject, signal });
      }),
    onDisplay: (step, value) => displayed.push([step, value]),
    onError: (step, error) => errors.push([step, error]),
    ...extra,
  });
  const resolve = (step: number): void => reads.get(step)?.resolve(step);
  const reject = (step: number, error: unknown): void => reads.get(step)?.reject(error);
  return { ring, reads, readStarts, displayed, errors, resolve, reject };
}

const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);

describe("createStreamRing", () => {
  it("decodes + displays the cursor and prefetches ±1; neighbours are cached, not displayed", async () => {
    const h = harness([0, 1, 2, 3, 4]);
    h.ring.setCursor(2);
    expect(sorted(h.readStarts)).toEqual([1, 2, 3]); // cursor + both neighbours
    for (const step of [2, 1, 3]) h.resolve(step);
    await tick();
    expect(h.displayed).toEqual([[2, 2]]); // only the cursor is displayed
    expect(sorted(h.ring.resident())).toEqual([1, 3]); // neighbours cached for an instant ±1 scrub
    expect(h.ring.pending()).toEqual([]);
  });

  it("displays a prefetched neighbour instantly — no second read for it (the no-stall win)", async () => {
    const h = harness([0, 1, 2, 3, 4]);
    h.ring.setCursor(2);
    for (const step of [2, 1, 3]) h.resolve(step);
    await tick();
    h.ring.setCursor(3); // 3 is already cached
    expect(h.displayed.at(-1)).toEqual([3, 3]); // shown from cache
    expect(h.readStarts.filter((s) => s === 3)).toHaveLength(1); // never re-read
  });

  it("aborts in-flight reads the cursor scrubbed past", async () => {
    const h = harness([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    h.ring.setCursor(0); // reads 0 (display) + 1
    const aborted0 = h.reads.get(0)?.signal;
    const aborted1 = h.reads.get(1)?.signal;
    h.ring.setCursor(5); // 0,1 fall outside {4,5,6} → aborted
    expect(aborted0?.aborted).toBe(true);
    expect(aborted1?.aborted).toBe(true);
    expect(sorted(h.ring.pending())).toEqual([4, 5, 6]);
    // The stale read resolving late must not display (its entry is gone).
    h.resolve(0);
    await tick();
    expect(h.displayed.map(([s]) => s)).not.toContain(0);
  });

  it("re-reads a displayed (consumed) step on scrub-back", async () => {
    const h = harness([0, 1, 2, 3, 4, 5, 6]);
    h.ring.setCursor(2);
    h.resolve(2);
    await tick();
    h.ring.setCursor(5);
    h.resolve(5);
    await tick();
    h.ring.setCursor(2); // 2 was consumed at first display → must read again
    expect(h.readStarts.filter((s) => s === 2)).toHaveLength(2);
    h.resolve(2);
    await tick();
    expect(h.displayed).toEqual([
      [2, 2],
      [5, 5],
      [2, 2],
    ]);
  });

  it("evicts the farthest cached steps beyond capacity", async () => {
    const h = harness([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { capacity: 2, prefetchRadius: 2 });
    h.ring.setCursor(4); // reads 4 (display) + {2,3,5,6}
    for (const step of [2, 3, 5, 6]) h.resolve(step);
    await tick();
    // Four neighbours decoded, capacity 2 → keep the two nearest (3,5), evict 2 and 6.
    expect(sorted(h.ring.resident())).toEqual([3, 5]);
  });

  it("never starts a duplicate concurrent read for the same step", async () => {
    const h = harness([0, 1, 2, 3, 4]);
    h.ring.setCursor(2); // starts 2,1,3
    h.ring.setCursor(3); // 3 already loading (→ display-on-complete), 2 still wanted; only 4 is new
    expect(h.readStarts).toEqual([2, 1, 3, 4]);
    h.resolve(3);
    await tick();
    expect(h.displayed.at(-1)).toEqual([3, 3]); // the in-flight 3 displays when it lands
  });

  it("reports a non-abort read failure via onError without displaying", async () => {
    const h = harness([0, 1, 2]);
    h.ring.setCursor(1);
    h.reject(1, new Error("decode failed"));
    await tick();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.[0]).toBe(1);
    expect(h.displayed).toEqual([]);
  });

  it("dispose aborts every in-flight read", () => {
    const h = harness([0, 1, 2, 3, 4]);
    h.ring.setCursor(2);
    const signals = [0, 1, 2, 3].map((s) => h.reads.get(s)?.signal).filter(Boolean);
    h.ring.dispose();
    expect(h.ring.pending()).toEqual([]);
    for (const signal of signals) expect(signal?.aborted).toBe(true);
  });
});
