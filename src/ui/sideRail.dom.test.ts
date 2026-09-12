import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import { installSideRail } from "./sideRail.ts";

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
  const dispose = installSideRail(parent, store, uiStore);
  disposers.push(dispose);
  const rail = parent.querySelector<HTMLElement>(".webpic-siderail");
  if (rail === null) throw new Error("side rail not mounted");
  const button = (control: string): HTMLButtonElement => {
    const element = rail.querySelector<HTMLButtonElement>(`[data-control="${control}"]`);
    if (element === null) throw new Error(`missing side-rail button: ${control}`);
    return element;
  };
  const flyout = (): HTMLElement => {
    const element = parent.querySelector<HTMLElement>(".webpic-flyout");
    if (element === null) throw new Error("flyout not mounted");
    return element;
  };
  // The visible add-menu (each add-button owns one, all `.webpic-railmenu`; only the open one shows).
  const openMenu = (): HTMLElement => {
    const element = parent.querySelector<HTMLElement>(".webpic-railmenu:not([hidden])");
    if (element === null) throw new Error("no open rail menu");
    return element;
  };
  return { parent, store, uiStore, rail, button, flyout, openMenu, dispose };
}

const ready = async (store: ReturnType<typeof createSimulationStore>): Promise<void> => {
  store.getState().setDataset(vectorTriple("B", { array: Float32Array }));
  await flushAsync(); // seeds the first volume layer
};

describe("installSideRail", () => {
  it("mounts the layer add-buttons, the Layers toggle, and the tools", () => {
    const { button } = setup();
    for (const control of [
      "layers",
      "add-volume",
      "add-slice",
      "add-fieldlines",
      "view",
      "probe",
      "diagnostics",
    ]) {
      expect(button(control)).toBeInstanceOf(window.HTMLButtonElement);
    }
    // Reserved/deferred primitives + tools are present but disabled.
    for (const control of ["add-particles", "reductions", "selections", "theme"]) {
      expect(button(control).disabled).toBe(true);
    }
  });

  it("the Layers button toggles the Layers overlay state and reflects aria-pressed", () => {
    const { uiStore, button } = setup();
    const layers = button("layers");
    expect(uiStore.getState().isLayersPanelOpen).toBe(false);
    expect(layers.getAttribute("aria-pressed")).toBe("false");
    layers.dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().isLayersPanelOpen).toBe(true);
    expect(layers.getAttribute("aria-pressed")).toBe("true");
    layers.dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().isLayersPanelOpen).toBe(false);
  });

  it("the Developer button toggles the Developer panel flag", () => {
    const { uiStore, button } = setup();
    const diag = button("diagnostics");
    expect(diag.getAttribute("aria-pressed")).toBe("false"); // a dev instrument — closed on boot
    diag.dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().panels.dev).toBe(true); // one click opens it, not two
    expect(diag.getAttribute("aria-pressed")).toBe("true");
    diag.dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().panels.dev).toBe(false);
  });

  it("an add-button opens a menu of instances + Add new; Add new adds a layer", async () => {
    const { store, button, openMenu } = setup();
    await ready(store);
    expect(store.getState().layers).toHaveLength(1); // the seeded volume
    button("add-volume").dispatchEvent(new MouseEvent("click"));
    const menu = openMenu();
    expect(menu.querySelectorAll(".webpic-railmenu_item")).toHaveLength(1); // one existing volume
    const add = menu.querySelector<HTMLButtonElement>(".webpic-railmenu_add");
    if (add === null) throw new Error("no Add new row");
    add.dispatchEvent(new MouseEvent("click"));
    // addLayerOfKind adds synchronously (recompute is fire-and-forget) → two volumes now.
    expect(store.getState().layers).toHaveLength(2);
    expect(store.getState().layers[1]?.kind).toBe("volume");
    expect(menu.hidden).toBe(true); // the menu closes on commit
  });

  it("picking an instance selects it and opens the Layers panel", async () => {
    const { store, uiStore, button, openMenu } = setup();
    await ready(store);
    const seededId = store.getState().layers[0]?.id;
    store.getState().selectLayer(null); // clear selection so the pick is observable
    button("add-volume").dispatchEvent(new MouseEvent("click"));
    const item = openMenu().querySelector<HTMLButtonElement>(".webpic-railmenu_item");
    if (item === null) throw new Error("no instance row");
    item.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().selectedLayerId).toBe(seededId);
    expect(uiStore.getState().isLayersPanelOpen).toBe(true);
  });

  it("the V shortcut adds a volume layer", async () => {
    const { store } = setup();
    await ready(store);
    expect(store.getState().layers).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "v" }));
    expect(store.getState().layers).toHaveLength(2);
  });

  it("the Axes & grid tab opens a flyout holding the scene controls", () => {
    const { button, flyout } = setup();
    const view = button("view");
    expect(view.getAttribute("aria-label")).toBe("Axes & grid");
    expect(flyout().hidden).toBe(true);
    view.dispatchEvent(new MouseEvent("click"));
    expect(flyout().hidden).toBe(false);
    const labels = [...flyout().querySelectorAll(".webpic-row_label")].map((n) => n.textContent);
    expect(labels).toContain("Grid");
    view.dispatchEvent(new MouseEvent("click"));
    expect(flyout().hidden).toBe(true);
  });

  it("the close button and Escape both dismiss the flyout", () => {
    const { button, flyout } = setup();
    const view = button("view");
    view.dispatchEvent(new MouseEvent("click"));
    const close = flyout().querySelector<HTMLButtonElement>(".webpic-flyout_close");
    if (close === null) throw new Error("no close button");
    close.dispatchEvent(new MouseEvent("click"));
    expect(flyout().hidden).toBe(true);
    view.dispatchEvent(new MouseEvent("click"));
    expect(flyout().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(flyout().hidden).toBe(true);
  });

  it("the Probe button toggles overlay.showPicker", () => {
    const { store, button } = setup();
    const probe = button("probe");
    expect(store.getState().overlay.showPicker).toBe(true);
    probe.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().overlay.showPicker).toBe(false);
    expect(probe.getAttribute("aria-pressed")).toBe("false");
  });

  it("hides on the global UI toggle and closes the flyout", () => {
    const { uiStore, rail, button, flyout } = setup();
    button("view").dispatchEvent(new MouseEvent("click"));
    expect(flyout().hidden).toBe(false);
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(true);
    expect(flyout().hidden).toBe(true);
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(false);
  });

  it("removes the rail, flyout, and menus on dispose", () => {
    const { parent, dispose } = setup();
    dispose();
    expect(parent.querySelector(".webpic-siderail")).toBeNull();
    expect(parent.querySelector(".webpic-flyout")).toBeNull();
    expect(parent.querySelector(".webpic-railmenu")).toBeNull();
  });
});
