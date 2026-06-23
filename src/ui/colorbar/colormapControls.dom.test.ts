import type { ColormapBinding } from "@schema/colormap.ts";
import { createSimulationStore, type SimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { fieldArray, makeDataset } from "../../../tests/fixtures.ts";
import { flushAsync } from "../../../tests/helpers.ts";
import { installColormapControls } from "./colormapControls.ts";

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
function swatch(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(".webpic-swatch");
  if (button === null) throw new Error("expected a colormap swatch button");
  return button;
}
function segments(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>(".webpic-segmented_seg"));
}
function segmentedDisabled(host: HTMLElement): boolean {
  return host.querySelector(".webpic-segmented")?.classList.contains("is-disabled") ?? false;
}
function activeBinding(store: SimulationStore): ColormapBinding | undefined {
  const { selectedLayerId, layers, colormapBindings } = store.getState();
  const id = layers.find((layer) => layer.id === selectedLayerId)?.colormapBindingId;
  return id != null ? colormapBindings[id] : undefined;
}
// The picker's gradient rows are body-appended by createPopover with a data-value each.
function pickColormap(value: string): void {
  const row = document.querySelector<HTMLElement>(`.webpic-popover_item[data-value="${value}"]`);
  if (row === null) throw new Error(`expected an open picker row for ${value}`);
  row.click();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("colormap controls (binding)", () => {
  it("is disabled until a field's range is known, then rebuilds enabled on setDataset", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();

    const dispose = installColormapControls(host, store); // no dataset yet
    expect(host.querySelector(".webpic-range")?.classList.contains("is-disabled")).toBe(true);
    for (const input of rangeInputs(host)) expect(input.disabled).toBe(true);
    expect(swatch(host).disabled).toBe(true);
    expect(segmentedDisabled(host)).toBe(true);

    store.getState().setDataset(bTriple());
    await flushAsync();
    expect(host.querySelector(".webpic-range")?.classList.contains("is-disabled")).toBe(false);
    const [lo, hi] = rangeInputs(host);
    expect(lo?.value).toBe("5"); // window interval [5, 6] from {center 5.5, width 1}
    expect(hi?.value).toBe("6");
    expect(swatch(host).disabled).toBe(false);
    expect(segmentedDisabled(host)).toBe(false);

    dispose();
    expect(host.querySelector(".webpic-pane")).toBeNull();
  });

  it("dispatches setBindingWindow on edit and reflects external window changes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColormapControls(host, store);
    const id = activeBinding(store)?.id ?? "";

    const [lo, hi] = rangeInputs(host);
    if (!lo || !hi) throw new Error("interval window needs two inputs");

    // Narrow the window via the hi field: [5, 5.5] → {center 5.25, width 0.5}.
    hi.value = "5.5";
    hi.dispatchEvent(new Event("change"));
    expect(activeBinding(store)?.window).toEqual({ center: 5.25, width: 0.5 });

    // An external reset reflects back into the control without a feedback loop.
    store.getState().setBindingWindow(id, 5.5, 1);
    expect(lo.value).toBe("5");
    expect(hi.value).toBe("6");

    dispose();
  });

  it("colormap picker dispatches setBindingColormap and reflects external changes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColormapControls(host, store);
    const id = activeBinding(store)?.id ?? "";

    const colormap = swatch(host);
    expect(colormap.dataset.value).toBe("inferno"); // seeded default

    colormap.click(); // open the gradient picker, then choose a row
    pickColormap("viridis");
    expect(activeBinding(store)?.colormap).toBe("viridis");

    store.getState().setBindingColormap(id, "plasma");
    expect(colormap.dataset.value).toBe("plasma"); // external reflect, no feedback loop

    dispose();
  });

  it("scale pill dispatches setBindingScale and re-bakes the window control", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColormapControls(host, store);

    const segs = segments(host);
    expect(segs.map((s) => s.dataset.value)).toEqual(["linear", "log", "symlog"]);
    const checked = (): string | undefined =>
      segs.find((s) => s.getAttribute("aria-checked") === "true")?.dataset.value;
    expect(checked()).toBe("linear");

    segs.find((s) => s.dataset.value === "log")?.click();
    expect(activeBinding(store)?.scale).toBe("log");
    expect(checked()).toBe("log"); // pill moved to the active segment
    // Window control survived the scale-triggered rebuild (still a two-grip interval).
    expect(rangeInputs(host)).toHaveLength(2);

    dispose();
  });
});
