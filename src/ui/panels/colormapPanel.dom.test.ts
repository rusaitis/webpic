import { createSimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { fieldArray, makeDataset } from "../../../tests/fixtures.ts";
import { installColormapPanel } from "./colormapPanel.ts";

// B triple → |B| = 5 (constant) → finite range widened to [5, 6], window {center 5.5, width 1}.
const bTriple = () =>
  makeDataset({
    B_1: fieldArray("B_1", new Float32Array([3]), [1]),
    B_2: fieldArray("B_2", new Float32Array([4]), [1]),
    B_3: fieldArray("B_3", new Float32Array([0]), [1]),
  });

function rangeInputs(host: HTMLElement): HTMLInputElement[] {
  return Array.from(host.querySelectorAll<HTMLInputElement>(".webpic-range_input"));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("colormap panel (window/level)", () => {
  it("is disabled until a field's range is known, then rebuilds enabled on setDataset", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();

    const dispose = installColormapPanel(host, store); // no dataset yet
    expect(host.querySelector(".webpic-range")?.classList.contains("is-disabled")).toBe(true);
    for (const input of rangeInputs(host)) expect(input.disabled).toBe(true);

    store.getState().setDataset(bTriple());
    expect(host.querySelector(".webpic-range")?.classList.contains("is-disabled")).toBe(false);
    const [lo, hi] = rangeInputs(host);
    expect(lo?.value).toBe("5"); // window interval [5, 6] from {center 5.5, width 1}
    expect(hi?.value).toBe("6");

    dispose();
    expect(host.querySelector(".webpic-pane")).toBeNull();
  });

  it("dispatches setWindowLevel on edit and reflects external window changes", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    const dispose = installColormapPanel(host, store);

    const [lo, hi] = rangeInputs(host);
    if (!lo || !hi) throw new Error("interval window needs two inputs");

    // Narrow the window via the hi field: [5, 5.5] → {center 5.25, width 0.5}.
    hi.value = "5.5";
    hi.dispatchEvent(new Event("change"));
    expect(store.getState().windowLevel).toEqual({ center: 5.25, width: 0.5 });

    // An external reset reflects back into the control without a feedback loop.
    store.getState().setWindowLevel(5.5, 1);
    expect(lo.value).toBe("5");
    expect(hi.value).toBe("6");

    dispose();
  });
});
