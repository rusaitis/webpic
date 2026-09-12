import { beforeEach, describe, expect, it } from "vitest";
import { releaseAlloc, resetLedger, trackAlloc, vramSnapshot } from "./vramLedger.ts";

// Module singleton — reset between cases so they don't leak state into each other.
describe("vramLedger", () => {
  beforeEach(resetLedger);

  it("starts empty", () => {
    expect(vramSnapshot()).toEqual({ totalBytes: 0, byKey: [] });
  });

  it("sums tracked allocations", () => {
    trackAlloc("a", 100);
    trackAlloc("b", 250);
    expect(vramSnapshot().totalBytes).toBe(350);
  });

  it("overwrites a key on realloc rather than accumulating", () => {
    trackAlloc("rt:composite", 1000);
    trackAlloc("rt:composite", 400); // resize to a smaller render target
    expect(vramSnapshot().totalBytes).toBe(400);
  });

  it("drops a released key", () => {
    trackAlloc("a", 100);
    trackAlloc("b", 50);
    releaseAlloc("a");
    expect(vramSnapshot().totalBytes).toBe(50);
    expect(vramSnapshot().byKey).toEqual([["b", 50]]);
  });

  it("treats release of an unknown key as a no-op", () => {
    trackAlloc("a", 100);
    releaseAlloc("missing");
    expect(vramSnapshot().totalBytes).toBe(100);
  });

  it("orders byKey largest-first", () => {
    trackAlloc("small", 10);
    trackAlloc("big", 9000);
    trackAlloc("mid", 500);
    expect(vramSnapshot().byKey.map(([key]) => key)).toEqual(["big", "mid", "small"]);
  });

  it("clears everything on resetLedger", () => {
    trackAlloc("a", 100);
    resetLedger();
    expect(vramSnapshot().totalBytes).toBe(0);
  });
});
