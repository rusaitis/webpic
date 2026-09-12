import { createSimulationStore, type SimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { makeDataset, makeField } from "../../../tests/fixtures.ts";
import { flushAsync } from "../../../tests/helpers.ts";
import { installDevPanel } from "./devPanel.ts";

// B triple → a seeded volume layer once a dataset loads.
const bTriple = () =>
  makeDataset({
    B_1: makeField("B_1", new Float32Array([3]), [1]),
    B_2: makeField("B_2", new Float32Array([4]), [1]),
    B_3: makeField("B_3", new Float32Array([0]), [1]),
  });

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

describe("installDevPanel — shading", () => {
  it("shading checkbox is disabled until a volume layer exists", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    const dispose = installDevPanel(host, store); // no dataset → no layer yet
    expect(shadingCheckbox(host).disabled).toBe(true);

    store.getState().setDataset(bTriple()); // seeds a volume layer
    await flushAsync();
    expect(shadingCheckbox(host).disabled).toBe(false);

    dispose();
    expect(host.querySelector(".webpic-pane")).toBeNull();
  });

  it("shading checkbox toggles the volume layer's Phong flag and reflects external changes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installDevPanel(host, store);

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
