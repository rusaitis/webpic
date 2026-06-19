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
  return { parent, store, uiStore, rail, button, dispose };
}

describe("installSideRail", () => {
  it("mounts the two tools: view, probe", () => {
    const { rail, button } = setup();
    expect(rail.querySelectorAll(".webpic-siderail_btn")).toHaveLength(2);
    for (const control of ["view", "probe"]) {
      expect(button(control)).toBeInstanceOf(window.HTMLButtonElement);
    }
  });

  it("the View button toggles the Scene panel and reflects aria-pressed", () => {
    const { uiStore, button } = setup();
    const view = button("view");
    // The Scene panel shows by default (panels.scene ?? true), so the toggle reads pressed.
    expect(view.getAttribute("aria-pressed")).toBe("true");
    view.dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().panels.scene).toBe(false);
    expect(view.getAttribute("aria-pressed")).toBe("false");
    // An external visibility change reflects back onto the button without a feedback loop.
    uiStore.getState().setPanelVisible("scene", true);
    expect(view.getAttribute("aria-pressed")).toBe("true");
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

  it("hides on the global UI toggle", () => {
    const { uiStore, rail } = setup();
    expect(rail.hidden).toBe(false);
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(true);
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(false);
  });

  it("removes the rail on dispose", () => {
    const { parent, dispose } = setup();
    dispose();
    expect(parent.querySelector(".webpic-siderail")).toBeNull();
  });
});
