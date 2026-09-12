// The HUD's number formatting and its degenerate-sample paths: an on-demand loop reports NaN frame
// intervals while idle and NaN wall-clocks on ticks the throttled GPU sync skipped, so every readout
// has to survive non-finite input without printing "NaN ms". Canvas is absent in happy-dom (2-D
// context is null), which the sparkline already guards — the text rows are the observable surface.

import { createPerfStore, createUiStore, type PerfSample } from "@store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPerfHud } from "./hud.ts";

const SAMPLE: PerfSample = {
  cpuEncodeMs: 4.25,
  frameWallMs: 12.5,
  frameIntervalMs: 1000 / 60,
  isContinuous: true,
  governorScale: 1,
  computeMs: null,
  vramBytes: 64 * 1024 * 1024,
};

let host: HTMLElement;
let perfStore: ReturnType<typeof createPerfStore>;
let uiStore: ReturnType<typeof createUiStore>;
let dispose: (() => void) | undefined;

function show(): void {
  perfStore.getState().setPerfHudVisible(true);
}

// Label → value, read off the compact rows (the detail panel is separate HTML).
function rows(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of host.querySelectorAll(".webpic-perf_row")) {
    const [label, value] = row.querySelectorAll("span");
    if (label?.textContent) out[label.textContent] = value?.textContent ?? "";
  }
  return out;
}

const fps = (): string => host.querySelector(".webpic-perf_fps")?.textContent ?? "";

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  perfStore = createPerfStore();
  uiStore = createUiStore();
  dispose = installPerfHud(host, perfStore, uiStore);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

describe("installPerfHud", () => {
  it("stays hidden until the HUD is toggled on", () => {
    const container = host.querySelector<HTMLElement>(".webpic-perf");
    expect(container?.hidden).toBe(true);
    show();
    expect(container?.hidden).toBe(false);
  });

  it("shows em-dashes for every metric before the first sample", () => {
    show();
    expect(rows()).toMatchObject({ cpu: "—", "frame ≈": "—", governor: "—", vram: "—" });
    expect(fps()).toBe("idle (on-demand)");
  });

  it("formats a live sample: ms to one decimal, vram in MB, gpu as frame − cpu", () => {
    show();
    perfStore.getState().setSample(SAMPLE);
    expect(rows()).toMatchObject({
      cpu: "4.3 ms",
      "gpu ≈": "8.3 ms", // 12.5 − 4.25
      "frame ≈": "12.5 ms",
      governor: "1.00×",
      vram: "64.0 MB",
    });
    expect(fps()).toBe("60 fps");
  });

  it("prints an em-dash, not NaN, for a frame the GPU sync skipped", () => {
    show();
    perfStore.getState().setSample({ ...SAMPLE, frameWallMs: Number.NaN });
    expect(rows()["frame ≈"]).toBe("—");
    expect(rows()["gpu ≈"]).toBe("—"); // undefined without a wall-clock, not a negative estimate
  });

  it("reads an infinite frame interval as idle rather than 0 fps", () => {
    show();
    perfStore.getState().setSample({ ...SAMPLE, frameIntervalMs: Number.POSITIVE_INFINITY });
    expect(fps()).toBe("idle (on-demand)");
  });

  it("reports a missing heap as n/a and a large heap in GB", () => {
    show();
    expect(rows().heap).toBe("n/a"); // no performance.memory in happy-dom
    perfStore.getState().setMainMetrics({ mainHeapBytes: 3 * 1024 ** 3 });
    expect(rows().heap).toBe("3.00 GB");
  });

  it("tints a slow frame and a throttled governor, and leaves a healthy one untinted", () => {
    show();
    const frameColor = (): string =>
      host.querySelectorAll<HTMLElement>(".webpic-perf_row span")[5]?.style.color ?? "";
    perfStore.getState().setSample({ ...SAMPLE, frameWallMs: 5 });
    const healthy = frameColor();
    perfStore.getState().setSample({ ...SAMPLE, frameWallMs: 50 });
    expect(frameColor()).not.toBe(healthy);
  });

  it("renders the detail panel's worker topology and jank rows when opened", () => {
    show();
    perfStore.getState().setTopology([
      { role: "main", live: true, heapBytes: 1024 * 1024 },
      { role: "data", live: false, heapBytes: null, note: "read 12 ms" },
    ]);
    perfStore.getState().toggleDetail();
    const detail = host.querySelector(".webpic-perf_detail");
    expect(detail?.textContent).toContain("● main");
    expect(detail?.textContent).toContain("1.0 MB");
    expect(detail?.textContent).toContain("○ data");
    expect(detail?.textContent).toContain("read 12 ms");
    expect(detail?.textContent).toContain("n/a"); // page-total with no measurement
  });

  it("hides with the rest of the UI and removes itself on dispose", () => {
    show();
    uiStore.getState().setUiVisible(false);
    expect(host.querySelector<HTMLElement>(".webpic-perf")?.hidden).toBe(true);
    dispose?.();
    dispose = undefined;
    expect(host.querySelector(".webpic-perf")).toBeNull();
    expect(document.head.querySelector(".webpic-perf-style")).toBeNull();
  });
});
