// The bridge's routing contract: HUD visibility gates both workers' sampling, worker self-reports
// land in the store as one topology, and teardown stops the pump + the workers. The metric pump runs
// on a real interval, so the tests drive it with fake timers rather than waiting.

import type { RenderResponse } from "@render/messages.ts";
import { createPerfStore, createUiStore } from "@store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPerf, type PerfBridge } from "./perfBridge.ts";

const renderSample: RenderResponse<"perfSample"> = {
  kind: "perfSample",
  cpuEncodeMs: 3,
  frameWallMs: 9,
  frameIntervalMs: 16,
  isContinuous: false,
  governorScale: 0.85,
  vramBytes: 128,
  vramByKey: [["layer-0", 128]],
  workerHeapBytes: 4096,
};

let host: HTMLElement;
let perfStore: ReturnType<typeof createPerfStore>;
let uiStore: ReturnType<typeof createUiStore>;
let renderWorker: { postMessage: ReturnType<typeof vi.fn<(message: unknown) => void>> };
let setDataPerfActive: ReturnType<typeof vi.fn<(active: boolean) => void>>;
let bridge: PerfBridge | undefined;
let isDataPresent = false;

function install(): PerfBridge {
  return installPerf({
    perfStore,
    uiStore,
    uiParent: host,
    renderWorker,
    setDataPerfActive,
    isRenderReady: () => true,
    isDataPresent: () => isDataPresent,
  });
}

const perfActiveFlags = (): boolean[] =>
  renderWorker.postMessage.mock.calls
    .map(([message]) => message as { kind: string; active: boolean })
    .filter((message) => message.kind === "setPerfActive")
    .map((message) => message.active);

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  perfStore = createPerfStore();
  uiStore = createUiStore();
  renderWorker = { postMessage: vi.fn() };
  setDataPerfActive = vi.fn();
  isDataPresent = false;
});

afterEach(() => {
  bridge?.dispose();
  bridge = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("installPerf", () => {
  it("mounts the HUD and applies the current visibility to both workers on install", () => {
    bridge = install();
    expect(host.querySelector(".webpic-perf")).not.toBeNull();
    expect(perfActiveFlags()).toEqual([false]);
    expect(setDataPerfActive).toHaveBeenCalledWith(false);
  });

  it("turns worker sampling on when the HUD opens and off when it closes", () => {
    bridge = install();
    perfStore.getState().setPerfHudVisible(true);
    perfStore.getState().setPerfHudVisible(false);
    expect(perfActiveFlags()).toEqual([false, true, false]);
    expect(setDataPerfActive.mock.calls.map(([on]) => on)).toEqual([false, true, false]);
  });

  it("routes a render worker sample into the store's sample + topology", () => {
    bridge = install();
    bridge.ingestRenderSample(renderSample);
    const state = perfStore.getState();
    expect(state.sample).toMatchObject({ cpuEncodeMs: 3, governorScale: 0.85, vramBytes: 128 });
    expect(state.topology.find((worker) => worker.role === "render")).toMatchObject({
      live: true,
      heapBytes: 4096,
    });
  });

  it("lists the data worker only once a stream exists, with its last read time", () => {
    bridge = install();
    bridge.ingestDataSample({ heapBytes: 2048, lastReadMs: 12.4 });
    expect(perfStore.getState().topology.map((worker) => worker.role)).toEqual(["main", "render"]);

    isDataPresent = true;
    bridge.ingestDataSample({ heapBytes: 2048, lastReadMs: 12.4 });
    expect(perfStore.getState().topology.at(-1)).toMatchObject({
      role: "data",
      heapBytes: 2048,
      note: "read 12 ms",
    });
  });

  it("pumps main-thread metrics only while the HUD is open", () => {
    bridge = install();
    vi.advanceTimersByTime(2000);
    expect(perfStore.getState().topology).toHaveLength(0); // closed: no pump, no topology

    perfStore.getState().setPerfHudVisible(true);
    expect(perfStore.getState().topology.map((worker) => worker.role)).toEqual(["main", "render"]);

    perfStore.getState().setPerfHudVisible(false);
    const seen = perfStore.getState().topology;
    vi.advanceTimersByTime(2000);
    expect(perfStore.getState().topology).toBe(seen); // pump stopped: nothing rebuilt
  });

  it("stops the workers and unmounts the HUD on dispose", () => {
    bridge = install();
    perfStore.getState().setPerfHudVisible(true);
    bridge.dispose();
    bridge = undefined;
    expect(perfActiveFlags().at(-1)).toBe(false);
    expect(setDataPerfActive.mock.calls.at(-1)?.[0]).toBe(false);
    expect(host.querySelector(".webpic-perf")).toBeNull();
    // A visibility change after teardown must not reach the workers.
    const posts = renderWorker.postMessage.mock.calls.length;
    perfStore.getState().setPerfHudVisible(true);
    expect(renderWorker.postMessage.mock.calls).toHaveLength(posts);
  });
});
