import { describe, expect, it } from "vitest";
import { createPerfStore } from "./perf.ts";

describe("perfStore", () => {
  it("starts hidden with no sample or topology", () => {
    const state = createPerfStore().getState();
    expect(state.isPerfHudVisible).toBe(false);
    expect(state.isPerfDetailOpen).toBe(false);
    expect(state.sample).toBeNull();
    expect(state.topology).toEqual([]);
    expect(state.mainHeapBytes).toBeNull();
  });

  it("toggles visibility", () => {
    const store = createPerfStore();
    store.getState().togglePerfHud();
    expect(store.getState().isPerfHudVisible).toBe(true);
    store.getState().togglePerfHud();
    expect(store.getState().isPerfHudVisible).toBe(false);
  });

  it("identity-guards setPerfHudVisible so a no-op set never fires subscribers", () => {
    const store = createPerfStore();
    let fires = 0;
    const unsub = store.subscribe(
      (s) => s.isPerfHudVisible,
      () => {
        fires += 1;
      },
    );
    store.getState().setPerfHudVisible(false); // already false → no fire
    expect(fires).toBe(0);
    store.getState().setPerfHudVisible(true);
    expect(fires).toBe(1);
    unsub();
  });

  it("stores the latest sample", () => {
    const store = createPerfStore();
    store.getState().setSample({
      cpuEncodeMs: 1.2,
      frameWallMs: 8,
      frameIntervalMs: 16.6,
      isContinuous: false,
      governorScale: 1,
      computeMs: null,
      vramBytes: 64 * 1024 * 1024,
    });
    expect(store.getState().sample?.vramBytes).toBe(64 * 1024 * 1024);
  });

  it("merges main metrics without clobbering keys absent from the patch", () => {
    const store = createPerfStore();
    store.getState().setMainMetrics({ mainHeapBytes: 1000 });
    store.getState().setMainMetrics({ pageMemoryBytes: 5000 });
    const state = store.getState();
    expect(state.mainHeapBytes).toBe(1000); // preserved across the second, disjoint patch
    expect(state.pageMemoryBytes).toBe(5000);
  });
});
