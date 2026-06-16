import { beforeEach, describe, expect, it } from "vitest";
import { releaseAlloc, resetLedger, snapshot, trackAlloc } from "./vramLedger.ts";

// Module singleton — reset between cases so they don't leak state into each other.
describe("vramLedger", () => {
  beforeEach(resetLedger);

  it("starts empty", () => {
    expect(snapshot()).toEqual({ totalBytes: 0, byKey: [] });
  });

  it("sums tracked allocations", () => {
    trackAlloc("a", 100);
    trackAlloc("b", 250);
    expect(snapshot().totalBytes).toBe(350);
  });

  it("overwrites a key on realloc rather than accumulating", () => {
    trackAlloc("rt:composite", 1000);
    trackAlloc("rt:composite", 400); // resize to a smaller render target
    expect(snapshot().totalBytes).toBe(400);
  });

  it("drops a released key", () => {
    trackAlloc("a", 100);
    trackAlloc("b", 50);
    releaseAlloc("a");
    expect(snapshot().totalBytes).toBe(50);
    expect(snapshot().byKey).toEqual([["b", 50]]);
  });

  it("treats release of an unknown key as a no-op", () => {
    trackAlloc("a", 100);
    releaseAlloc("missing");
    expect(snapshot().totalBytes).toBe(100);
  });

  it("orders byKey largest-first", () => {
    trackAlloc("small", 10);
    trackAlloc("big", 9000);
    trackAlloc("mid", 500);
    expect(snapshot().byKey.map(([key]) => key)).toEqual(["big", "mid", "small"]);
  });

  it("clears everything on resetLedger", () => {
    trackAlloc("a", 100);
    resetLedger();
    expect(snapshot().totalBytes).toBe(0);
  });
});
