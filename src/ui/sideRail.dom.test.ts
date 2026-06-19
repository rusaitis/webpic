import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
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
    const el = rail.querySelector<HTMLButtonElement>(`[data-control="${control}"]`);
    if (el === null) throw new Error(`missing side-rail button: ${control}`);
    return el;
  };
  const flyout = (): HTMLElement => {
    const el = parent.querySelector<HTMLElement>(".webpic-flyout");
    if (el === null) throw new Error("flyout not mounted");
    return el;
  };
  return { parent, store, uiStore, rail, button, flyout, dispose };
}

describe("installSideRail", () => {
  it("mounts the two tools: view, probe", () => {
    const { rail, button } = setup();
    expect(rail.querySelectorAll(".webpic-siderail_btn")).toHaveLength(2);
    for (const control of ["view", "probe"]) {
      expect(button(control)).toBeInstanceOf(window.HTMLButtonElement);
    }
  });

  it("the Axes & grid tab opens a flyout holding the scene controls", () => {
    const { button, flyout } = setup();
    const view = button("view");
    expect(view.getAttribute("aria-label")).toBe("Axes & grid");
    // Closed by default.
    expect(flyout().hidden).toBe(true);
    expect(view.getAttribute("aria-expanded")).toBe("false");
    view.dispatchEvent(new MouseEvent("click"));
    expect(flyout().hidden).toBe(false);
    expect(view.getAttribute("aria-expanded")).toBe("true");
    // The flyout body carries the mounted reference-frame controls.
    const labels = [...flyout().querySelectorAll(".webpic-row_label")].map((n) => n.textContent);
    expect(labels).toContain("Grid");
    // Re-click closes.
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
    view.dispatchEvent(new MouseEvent("click")); // reopen
    expect(flyout().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(flyout().hidden).toBe(true);
  });

  it("an outside pointer-down closes the open flyout", () => {
    const { parent, button, flyout } = setup();
    button("view").dispatchEvent(new MouseEvent("click"));
    expect(flyout().hidden).toBe(false);
    parent.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(flyout().hidden).toBe(true);
  });

  it("the Probe button toggles overlay.showPicker", () => {
    const { store, button } = setup();
    const probe = button("probe");
    expect(store.getState().overlay.showPicker).toBe(true);
    expect(probe.getAttribute("aria-pressed")).toBe("true");
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
    expect(flyout().hidden).toBe(true); // not stranded over hidden UI
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(false);
  });

  it("removes the rail and flyout on dispose", () => {
    const { parent, dispose } = setup();
    dispose();
    expect(parent.querySelector(".webpic-siderail")).toBeNull();
    expect(parent.querySelector(".webpic-flyout")).toBeNull();
  });
});
