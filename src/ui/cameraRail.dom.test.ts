import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installCameraRail } from "./cameraRail.ts";

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
  const dispose = installCameraRail(parent, store, uiStore);
  disposers.push(dispose);
  const rail = parent.querySelector<HTMLElement>(".webpic-rail");
  if (rail === null) throw new Error("rail not mounted");
  const button = (control: string): HTMLButtonElement => {
    const el = rail.querySelector<HTMLButtonElement>(`[data-control="${control}"]`);
    if (el === null) throw new Error(`missing rail button: ${control}`);
    return el;
  };
  const card = (): HTMLElement => {
    const el = parent.querySelector<HTMLElement>(".webpic-coords-card");
    if (el === null) throw new Error("coords card not mounted");
    return el;
  };
  return { parent, store, uiStore, rail, button, card, dispose };
}

describe("installCameraRail", () => {
  it("mounts the five controls: gnomon, fly, projection, coords, help", () => {
    const { rail, button } = setup();
    expect(rail.querySelectorAll(".webpic-rail_btn")).toHaveLength(5);
    for (const control of ["gnomon", "fly", "projection", "coords", "help"]) {
      expect(button(control)).toBeInstanceOf(window.HTMLButtonElement);
    }
  });

  it("the fly button toggles isFlyMode and reflects it on aria-pressed", () => {
    const { store, button } = setup();
    const fly = button("fly");
    expect(store.getState().isFlyMode).toBe(false);
    expect(fly.getAttribute("aria-pressed")).toBe("false");
    fly.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().isFlyMode).toBe(true);
    expect(fly.getAttribute("aria-pressed")).toBe("true");
    // External state change (e.g. the N shortcut) reflects back onto the button.
    store.getState().setFlyMode(false);
    expect(fly.getAttribute("aria-pressed")).toBe("false");
  });

  it("the projection button toggles perspective⇄orthographic", () => {
    const { store, button } = setup();
    const proj = button("projection");
    expect(store.getState().projection).toBe("perspective");
    proj.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().projection).toBe("orthographic");
    expect(proj.getAttribute("aria-pressed")).toBe("true");
    proj.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().projection).toBe("perspective");
  });

  it("the gnomon button toggles overlay.showGnomon and the has-gnomon inset", () => {
    const { store, rail, button } = setup();
    const gnomon = button("gnomon");
    // Default overlay shows the gnomon, so the rail reserves its footprint.
    expect(store.getState().overlay.showGnomon).toBe(true);
    expect(rail.classList.contains("has-gnomon")).toBe(true);
    expect(gnomon.getAttribute("aria-pressed")).toBe("true");
    gnomon.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().overlay.showGnomon).toBe(false);
    expect(rail.classList.contains("has-gnomon")).toBe(false); // re-centers across full width
    expect(gnomon.getAttribute("aria-pressed")).toBe("false");
  });

  it("the help button toggles the help overlay", () => {
    const { uiStore, button } = setup();
    expect(uiStore.getState().isHelpVisible).toBe(false);
    button("help").dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().isHelpVisible).toBe(true);
  });

  it("the coords chip reads — with no dataset loaded", () => {
    const { button } = setup();
    expect(button("coords").textContent).toBe("—");
  });

  it("clicking the coords chip toggles the grid-info card + aria-expanded", () => {
    const { uiStore, button, card } = setup();
    const coords = button("coords");
    expect(card().hidden).toBe(true);
    expect(coords.getAttribute("aria-expanded")).toBe("false");
    coords.dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().isCoordsInfoVisible).toBe(true);
    expect(card().hidden).toBe(false);
    expect(coords.getAttribute("aria-expanded")).toBe("true");
    coords.dispatchEvent(new MouseEvent("click"));
    expect(card().hidden).toBe(true);
    expect(coords.getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes the open card", () => {
    const { uiStore, button, card } = setup();
    button("coords").dispatchEvent(new MouseEvent("click"));
    expect(card().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(uiStore.getState().isCoordsInfoVisible).toBe(false);
    expect(card().hidden).toBe(true);
  });

  it("the C shortcut toggles the card", () => {
    const { uiStore, card } = setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC" }));
    expect(uiStore.getState().isCoordsInfoVisible).toBe(true);
    expect(card().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC" }));
    expect(uiStore.getState().isCoordsInfoVisible).toBe(false);
  });

  it("a pointer-down outside the card + chip closes it", () => {
    const { uiStore, button, parent } = setup();
    button("coords").dispatchEvent(new MouseEvent("click")); // open
    expect(uiStore.getState().isCoordsInfoVisible).toBe(true);
    parent.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); // outside both
    expect(uiStore.getState().isCoordsInfoVisible).toBe(false);
  });

  it("splits the pose into View + Center rows and carries no copy button", () => {
    const { store, button, card } = setup();
    button("coords").dispatchEvent(new MouseEvent("click")); // open the card
    const labels = [...card().querySelectorAll(".webpic-coords-card_label")].map(
      (n) => n.textContent,
    );
    expect(labels).toContain("View");
    expect(labels).toContain("Center");
    // Center tracks the orbit target; View carries the angles/zoom, not the target.
    store
      .getState()
      .setCameraPose({ target: [1, -2, 0.5], azimuth: 0, elevation: 0, distance: 3, roll: 0 });
    const rows = [...card().querySelectorAll(".webpic-coords-card_row")];
    const centerRow = rows.find(
      (r) => r.querySelector(".webpic-coords-card_label")?.textContent === "Center",
    );
    expect(centerRow?.querySelector(".webpic-coords-card_value")?.textContent).toBe(
      "1.00, -2.00, 0.50",
    );
    expect(card().querySelector(".webpic-coords-card_copy")).toBeNull(); // sharing moves to a top menu
  });

  it("hides the rail and closes the card on the global UI toggle", () => {
    const { uiStore, rail, button } = setup();
    button("coords").dispatchEvent(new MouseEvent("click")); // open the card
    expect(uiStore.getState().isCoordsInfoVisible).toBe(true);
    expect(rail.hidden).toBe(false);
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(true);
    expect(uiStore.getState().isCoordsInfoVisible).toBe(false); // force-closed with the UI
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(false);
  });

  it("removes the rail and the card on dispose", () => {
    const { parent, dispose } = setup();
    dispose();
    expect(parent.querySelector(".webpic-rail")).toBeNull();
    expect(parent.querySelector(".webpic-coords-card")).toBeNull();
  });
});
