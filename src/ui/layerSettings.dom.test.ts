import { createSimulationStore, createUiStore, makeDefaultLayer } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { dummyGrid, fieldArray, makeDataset, vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import { installLayerSettings } from "./layerSettings.ts";

// happy-dom: assert that each control dispatches the right store intent for the selected layer, and
// that the kind-specific section rebuilds per kind. The render worker is out of scope.

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
  disposers.push(installLayerSettings(parent, store, uiStore));
  const win = parent.querySelector<HTMLElement>(".webpic-window");
  if (win === null) throw new Error("settings window not mounted");
  const open = () => uiStore.getState().setLayerSettingsVisible(true);
  return { parent, store, uiStore, win, open };
}

const seed = async (store: ReturnType<typeof createSimulationStore>): Promise<void> => {
  store.getState().setDataset(vectorTriple("B", { array: Float32Array }));
  await flushAsync();
};

function rowByLabel(host: HTMLElement, label: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".webpic-row")].find(
    (r) => r.querySelector(".webpic-row_label")?.textContent === label,
  );
  if (!row) throw new Error(`no row labelled "${label}"`);
  return row;
}
const checkbox = (host: HTMLElement, label: string): HTMLInputElement => {
  const input = rowByLabel(host, label).querySelector<HTMLInputElement>(".webpic-checkbox_input");
  if (!input) throw new Error(`no checkbox in "${label}"`);
  return input;
};
const range = (host: HTMLElement, label: string): HTMLInputElement => {
  const input = rowByLabel(host, label).querySelector<HTMLInputElement>(".webpic-range_input");
  if (!input) throw new Error(`no range field in "${label}"`);
  return input;
};
const button = (host: HTMLElement, text: string): HTMLButtonElement => {
  const el = [...host.querySelectorAll<HTMLButtonElement>(".webpic-layerset_btn")].find(
    (b) => b.textContent === text,
  );
  if (!el) throw new Error(`no button "${text}"`);
  return el;
};

describe("installLayerSettings", () => {
  it("is hidden until opened", async () => {
    const { store, win, open } = setup();
    await seed(store);
    expect(win.hidden).toBe(true);
    open();
    expect(win.hidden).toBe(false);
  });

  it("shows an empty state when nothing is selected", () => {
    const { win, open } = setup();
    open();
    expect(win.querySelector(".webpic-layerset_empty")).not.toBeNull();
  });

  it("the opacity slider dispatches setLayerOpacity for the selected layer", async () => {
    const { store, win, open } = setup();
    await seed(store); // volume layer-0 (selected)
    open();
    const input = range(win, "Opacity");
    input.value = "0.4";
    input.dispatchEvent(new Event("change"));
    expect(store.getState().layers[0]?.opacity).toBeCloseTo(0.4);
  });

  it("the Visible checkbox dispatches setLayerVisible", async () => {
    const { store, win, open } = setup();
    await seed(store);
    open();
    const input = checkbox(win, "Visible");
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    expect(store.getState().layers[0]?.visible).toBe(false);
  });

  it("the volume Phong checkbox dispatches setLayerShading", async () => {
    const { store, win, open } = setup();
    await seed(store);
    open();
    const input = checkbox(win, "Phong shading");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(store.getState().layers[0]).toMatchObject({ kind: "volume", shaded: true });
  });

  it("Remove dispatches removeLayer", async () => {
    const { store, win, open } = setup();
    await seed(store);
    open();
    button(win, "Remove").dispatchEvent(new MouseEvent("click"));
    expect(store.getState().layers).toHaveLength(0);
  });

  it("rebuilds the kind-specific section for a slice (axis + position)", async () => {
    const { store, win, open } = setup();
    await seed(store);
    store.getState().addLayer(makeDefaultLayer("ignored", "|B|", "slice")); // layer-1, selected
    open();
    const id = "layer-1";
    const xBtn = [
      ...rowByLabel(win, "Axis").querySelectorAll<HTMLButtonElement>(".webpic-segmented_seg"),
    ].find((b) => b.textContent === "x");
    xBtn?.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().layers.find((l) => l.id === id)).toMatchObject({ axis: "x" });

    const pos = range(win, "Position");
    pos.value = "0.25";
    pos.dispatchEvent(new Event("change"));
    const slice = store.getState().layers.find((l) => l.id === id);
    expect(slice?.kind === "slice" && slice.position).toBeCloseTo(0.25);
  });

  it("the fieldlines section toggles seed placement", async () => {
    const { store, win, open } = setup();
    await seed(store);
    store.getState().addLayer(makeDefaultLayer("ignored", "|B|", "fieldlines")); // layer-1, selected
    open();
    const place = checkbox(win, "Place seeds");
    place.checked = true;
    place.dispatchEvent(new Event("change"));
    expect(store.getState().seedPlacementLayerId).toBe("layer-1");
  });

  it("the seed note reports what the last retrace did, amber when seeds were dropped", async () => {
    const { store, win, open } = setup();
    // A 4³ uniform B = (0,0,1): traceable, so the note can show a real line count.
    const size = 4 ** 3;
    store.getState().setDataset(
      makeDataset(
        {
          B_1: fieldArray("B_1", new Float64Array(size), [4, 4, 4]),
          B_2: fieldArray("B_2", new Float64Array(size), [4, 4, 4]),
          B_3: fieldArray("B_3", new Float64Array(size).fill(1), [4, 4, 4]),
        },
        { grid: dummyGrid([4, 4, 4]) },
      ),
    );
    await flushAsync();
    store.getState().addLayer(makeDefaultLayer("ignored", "|B|", "fieldlines")); // layer-1, selected
    open();
    const note = () => win.querySelector<HTMLElement>(".webpic-placeholder");
    expect(note()?.textContent).toContain("0 seeds"); // no retrace yet — just the placement hint
    expect(note()?.dataset.kind).toBeUndefined();

    store.getState().setFieldlineSeeds("layer-1", [
      [2, 2, 2],
      [100, 100, 100], // stale — another grid's coordinates
    ]);
    await flushAsync();
    expect(note()?.textContent).toContain("2 seeds");
    expect(note()?.textContent).toContain("1 line");
    expect(note()?.textContent).toContain("1 seed outside the domain");
    expect(note()?.dataset.kind).toBe("warn");
  });

  it("hides with the global UI toggle and tears down on dispose", async () => {
    const { parent, store, uiStore, win, open } = setup();
    await seed(store);
    open();
    expect(win.hidden).toBe(false);
    uiStore.getState().toggleUi();
    expect(win.hidden).toBe(true);
    for (const dispose of disposers.splice(0)) dispose();
    expect(parent.querySelector(".webpic-window")).toBeNull();
  });
});
