import type { ColormapBinding } from "@schema/colormap.ts";
import { createSimulationStore, type SimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { fieldArray, makeDataset } from "../../../tests/fixtures.ts";
import { flushAsync } from "../../../tests/helpers.ts";
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
function selects(host: HTMLElement): HTMLSelectElement[] {
  return Array.from(host.querySelectorAll<HTMLSelectElement>(".webpic-select"));
}
function activeBinding(store: SimulationStore): ColormapBinding | undefined {
  const { selectedLayerId, layers, colormapBindings } = store.getState();
  const id = layers.find((layer) => layer.id === selectedLayerId)?.colormapBindingId;
  return id != null ? colormapBindings[id] : undefined;
}
function pick(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change"));
}
function shadingCheckbox(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(".webpic-checkbox_input");
  if (input === null) throw new Error("no shading checkbox");
  return input;
}
function shadedFlag(store: SimulationStore): boolean {
  const { selectedLayerId, layers } = store.getState();
  const layer = layers.find((l) => l.id === selectedLayerId);
  return layer?.kind === "volume" ? layer.shaded : false;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("colormap panel (binding)", () => {
  it("is disabled until a field's range is known, then rebuilds enabled on setDataset", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();

    const dispose = installColormapPanel(host, store); // no dataset yet
    expect(host.querySelector(".webpic-range")?.classList.contains("is-disabled")).toBe(true);
    for (const input of rangeInputs(host)) expect(input.disabled).toBe(true);
    for (const select of selects(host)) expect(select.disabled).toBe(true);

    store.getState().setDataset(bTriple());
    await flushAsync();
    expect(host.querySelector(".webpic-range")?.classList.contains("is-disabled")).toBe(false);
    const [lo, hi] = rangeInputs(host);
    expect(lo?.value).toBe("5"); // window interval [5, 6] from {center 5.5, width 1}
    expect(hi?.value).toBe("6");
    expect(selects(host).map((s) => s.disabled)).toEqual([false, false]);

    dispose();
    expect(host.querySelector(".webpic-pane")).toBeNull();
  });

  it("dispatches setBindingWindow on edit and reflects external window changes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColormapPanel(host, store);
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

  it("colormap select dispatches setBindingColormap and reflects external changes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColormapPanel(host, store);
    const id = activeBinding(store)?.id ?? "";

    const [colormap] = selects(host);
    if (!colormap) throw new Error("expected a colormap select");
    expect(colormap.value).toBe("inferno"); // seeded default

    pick(colormap, "viridis");
    expect(activeBinding(store)?.colormap).toBe("viridis");

    store.getState().setBindingColormap(id, "plasma");
    expect(colormap.value).toBe("plasma"); // external reflect, no feedback loop

    dispose();
  });

  it("scale select dispatches setBindingScale and re-bakes the window control", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColormapPanel(host, store);

    const scale = selects(host)[1];
    if (!scale) throw new Error("expected a scale select");
    expect(scale.value).toBe("linear");

    pick(scale, "log");
    expect(activeBinding(store)?.scale).toBe("log");
    // Window control survived the scale-triggered rebuild (still a two-grip interval).
    expect(rangeInputs(host)).toHaveLength(2);

    dispose();
  });

  it("shading checkbox is disabled until a volume layer exists", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    const dispose = installColormapPanel(host, store); // no dataset → no layer yet
    expect(shadingCheckbox(host).disabled).toBe(true);

    store.getState().setDataset(bTriple()); // seeds a volume layer
    await flushAsync();
    expect(shadingCheckbox(host).disabled).toBe(false);

    dispose();
  });

  it("shading checkbox toggles the volume layer's Phong flag and reflects external changes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColormapPanel(host, store);

    const box = shadingCheckbox(host);
    expect(box.checked).toBe(false); // Phong off by default for quantitative work
    expect(shadedFlag(store)).toBe(false);

    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(shadedFlag(store)).toBe(true);

    store.getState().setLayerShading(store.getState().selectedLayerId ?? "", false);
    expect(box.checked).toBe(false); // external reflect, no feedback loop

    dispose();
  });
});
