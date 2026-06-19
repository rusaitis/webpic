import { createSimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installScenePanel } from "./scenePanel.ts";

afterEach(() => {
  document.body.replaceChildren();
});

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

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const store = createSimulationStore();
  const dispose = installScenePanel(host, store);
  return { host, store, dispose };
}

describe("scene panel", () => {
  it("toggling the Grid checkbox dispatches setOverlayShowGrid", () => {
    const { host, store, dispose } = mount();
    expect(store.getState().overlay.showGrid).toBe(true);

    const input = checkbox(host, "Grid");
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    expect(store.getState().overlay.showGrid).toBe(false);

    dispose();
    expect(host.querySelector(".webpic-pane")).toBeNull();
  });

  it("toggling a plane checkbox dispatches setOverlayPlane for that plane only", () => {
    const { host, store, dispose } = mount();
    const input = checkbox(host, "YZ plane");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(store.getState().overlay.planes).toEqual({ xy: true, yz: true, xz: false });
    dispose();
  });

  it("the Density slider dispatches setGridDivisions", () => {
    const { host, store, dispose } = mount();
    // The slider is the shared RangeControl primitive — drive it through its text field.
    const input = rowByLabel(host, "Density").querySelector<HTMLInputElement>(
      ".webpic-range_input",
    );
    if (!input) throw new Error("no density slider");
    input.value = "12";
    input.dispatchEvent(new Event("change"));
    expect(store.getState().overlay.gridDivisions).toBe(12);
    dispose();
  });

  it("reflects an external overlay change into the controls without a feedback loop", () => {
    const { host, store, dispose } = mount();
    store.getState().setOverlayShowAxes(false);
    expect(checkbox(host, "Axes").checked).toBe(false);
    // The reflection must not echo back into a second store write (value already matched).
    expect(store.getState().overlay.showAxes).toBe(false);
    dispose();
  });
});
