import { createPerfStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installTimingPanel, rollingMean } from "./timingPanel.ts";

function readoutText(host: HTMLElement): string {
  return host.querySelector(".webpic-placeholder")?.textContent ?? "";
}
function measureCheckbox(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(".webpic-checkbox_input");
  if (!input) throw new Error("expected the Measure checkbox");
  return input;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("rollingMean", () => {
  it("averages finite samples, skipping NaN/Infinity", () => {
    expect(rollingMean([2, 4, 6])).toBe(4);
    expect(rollingMean([2, Number.NaN, 6])).toBe(4);
    expect(rollingMean([Number.POSITIVE_INFINITY, 3])).toBe(3);
  });
  it("is NaN with no finite samples", () => {
    expect(rollingMean([])).toBeNaN();
    expect(rollingMean([Number.NaN])).toBeNaN();
  });
});

describe("installTimingPanel", () => {
  it("starts awaiting a frame, then shows a rolling readout against the 8 ms gate", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createPerfStore();
    const dispose = installTimingPanel(host, store);

    expect(readoutText(host)).toContain("awaiting first frame");

    store.getState().setFrameTiming(6, "timestamp");
    expect(readoutText(host)).toContain("6.00 ms");
    expect(readoutText(host)).toContain("≤ 8 ms");
    expect(readoutText(host)).toContain("timestamp-query");

    store.getState().setFrameTiming(10, "timestamp");
    store.getState().setFrameTiming(14, "timestamp"); // rolling mean (6,10,14) = 10 → over gate
    expect(readoutText(host)).toContain("10.00 ms");
    expect(readoutText(host)).toContain("> 8 ms");

    dispose();
    expect(host.querySelector(".webpic-pane")).toBeNull();
  });

  it("labels the wall-clock fallback distinctly from timestamp-query", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createPerfStore();
    const dispose = installTimingPanel(host, store);
    store.getState().setFrameTiming(3, "wallclock");
    expect(readoutText(host)).toContain("wall-clock");
    expect(readoutText(host)).not.toContain("timestamp-query");
    dispose();
  });

  it("the Measure checkbox toggles isMeasuringContinuous and resets it on dispose", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createPerfStore();
    const dispose = installTimingPanel(host, store);

    expect(store.getState().isMeasuringContinuous).toBe(false);
    const checkbox = measureCheckbox(host);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(store.getState().isMeasuringContinuous).toBe(true);

    dispose();
    expect(store.getState().isMeasuringContinuous).toBe(false); // teardown never strands the mode
  });

  it("reflects an external continuous toggle into the checkbox without a feedback loop", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createPerfStore();
    const dispose = installTimingPanel(host, store);

    store.getState().setMeasuringContinuous(true);
    expect(measureCheckbox(host).checked).toBe(true);

    dispose();
  });
});
