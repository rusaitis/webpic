import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { vectorTriple } from "../../../tests/fixtures.ts";
import { flushAsync } from "../../../tests/helpers.ts";
import { installLayersPanel } from "./panel.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function setup() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const store = createSimulationStore();
  const uiStore = createUiStore();
  const dispose = installLayersPanel(parent, store, uiStore);
  disposers.push(dispose);
  const root = parent.querySelector<HTMLElement>(".webpic-layers");
  if (root === null) throw new Error("layers panel not mounted");
  const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".webpic-layers_row")];
  const open = () => uiStore.getState().setLayersPanelVisible(true);
  return { parent, store, uiStore, root, rows, open, dispose };
}

// Seed a single volume layer; resolve once compute settles.
const seed = async (store: ReturnType<typeof createSimulationStore>): Promise<void> => {
  store.getState().setDataset(vectorTriple("B", { array: Float32Array }));
  await flushAsync();
};

describe("installLayersPanel", () => {
  it("is hidden until the overlay is opened", () => {
    const { root, uiStore } = setup();
    expect(root.hidden).toBe(true);
    uiStore.getState().toggleLayersPanel();
    expect(root.hidden).toBe(false);
  });

  it("opens on the L shortcut", () => {
    const { root } = setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "l" }));
    expect(root.hidden).toBe(false);
  });

  it("shows an empty state with no layers", () => {
    const { root, open } = setup();
    open();
    expect(root.querySelector(".webpic-layers_empty")).not.toBeNull();
    expect(root.querySelectorAll(".webpic-layers_row")).toHaveLength(0);
  });

  it("renders one row per layer with kind + field label", async () => {
    const { store, rows, open } = setup();
    await seed(store);
    open();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.querySelector(".webpic-layers_name")?.textContent).toBe("Volume |B|");
  });

  it("the eye toggles layer visibility", async () => {
    const { store, rows, open } = setup();
    await seed(store);
    open();
    const eye = rows()[0]?.querySelector<HTMLButtonElement>(".webpic-layers_eye");
    expect(store.getState().layers[0]?.visible).toBe(true);
    eye?.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().layers[0]?.visible).toBe(false);
  });

  it("clicking a row selects the layer; the highlight follows the selection", async () => {
    const { store, rows, open } = setup();
    await seed(store);
    const id = store.getState().layers[0]?.id;
    store.getState().selectLayer(null);
    open();
    expect(rows()[0]?.classList.contains("is-selected")).toBe(false);
    rows()[0]
      ?.querySelector<HTMLButtonElement>(".webpic-layers_main")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().selectedLayerId).toBe(id);
    expect(rows()[0]?.classList.contains("is-selected")).toBe(true);
  });

  it("the reorder buttons move a layer in the draw order", async () => {
    const { store, rows, open } = setup();
    await seed(store); // layer-0
    store.getState().addLayerOfKind("volume"); // layer-1 (recompute is async)
    await flushAsync();
    open();
    const [first, second] = [store.getState().layers[0]?.id, store.getState().layers[1]?.id];
    // Move the second row up.
    const up = rows()[1]?.querySelector<HTMLButtonElement>('[aria-label="Move up"]');
    up?.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().layers.map((l) => l.id)).toEqual([second, first]);
  });

  it("disables reorder at the ends of the list", async () => {
    const { store, rows, open } = setup();
    await seed(store);
    store.getState().addLayerOfKind("volume");
    await flushAsync();
    open();
    const top = rows()[0]?.querySelector<HTMLButtonElement>('[aria-label="Move up"]');
    const bottom = rows()[1]?.querySelector<HTMLButtonElement>('[aria-label="Move down"]');
    expect(top?.disabled).toBe(true);
    expect(bottom?.disabled).toBe(true);
  });

  it("hides when the global UI is toggled off", async () => {
    const { store, uiStore, root, open } = setup();
    await seed(store);
    open();
    expect(root.hidden).toBe(false);
    uiStore.getState().toggleUi();
    expect(root.hidden).toBe(true);
  });

  it("removes the panel on dispose", () => {
    const { parent, dispose } = setup();
    dispose();
    expect(parent.querySelector(".webpic-layers")).toBeNull();
  });
});
