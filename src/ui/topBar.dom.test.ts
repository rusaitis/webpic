import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { installTopBar } from "./topBar.ts";

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
  const dispose = installTopBar(parent, store, uiStore);
  disposers.push(dispose);
  const bar = parent.querySelector<HTMLElement>(".webpic-topbar");
  if (bar === null) throw new Error("top bar not mounted");
  const control = (c: string): HTMLButtonElement => {
    const el = bar.querySelector<HTMLButtonElement>(`[data-control="${c}"]`);
    if (el === null) throw new Error(`missing control: ${c}`);
    return el;
  };
  const slider = (): HTMLInputElement => {
    const el = bar.querySelector<HTMLInputElement>(".webpic-topbar_slider");
    if (el === null) throw new Error("missing slider");
    return el;
  };
  const popover = (): HTMLElement | null =>
    [...document.body.querySelectorAll<HTMLElement>(".webpic-popover")].find((p) => !p.hidden) ??
    null;
  return { parent, store, uiStore, bar, control, slider, popover, dispose };
}

describe("installTopBar", () => {
  it("mounts the brand, pickers, time control, and four disabled placeholders", () => {
    const { bar, control, slider } = setup();
    expect(bar.querySelector(".webpic-topbar_brand")?.textContent).toContain("webpic");
    expect(control("dataset")).toBeInstanceOf(window.HTMLButtonElement);
    expect(control("field")).toBeInstanceOf(window.HTMLButtonElement);
    expect(slider()).toBeInstanceOf(window.HTMLInputElement);
    for (const c of ["step-prev", "step-next"]) {
      expect(control(c)).toBeInstanceOf(window.HTMLButtonElement);
    }
    for (const c of ["upload", "layers", "export", "layout"]) {
      expect(control(c).disabled).toBe(true);
      expect(control(c).getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("opens the dataset popover and dispatches selectDataset on choose", () => {
    const { store, control, popover } = setup();
    const btn = control("dataset");
    expect(btn.textContent).toContain("Flux rope");
    btn.dispatchEvent(new MouseEvent("click"));
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const panel = popover();
    expect(panel).not.toBeNull();
    const dipole = [...(panel?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
      (o) => o.dataset.value === "dipole",
    );
    expect(dipole).toBeDefined();
    dipole?.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().datasetId).toBe("dipole");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("reflects an external dataset switch onto the button label", () => {
    const { store, control } = setup();
    store.getState().selectDataset("dipole");
    expect(control("dataset").textContent).toContain("Dipole");
  });

  it("lists available fields with metadata and dispatches selectField", () => {
    const { store, control, popover } = setup();
    store.getState().setDataset(vectorTriple("B", { array: Float32Array }));
    const fields = store.getState().availableFields;
    expect(fields.length).toBeGreaterThan(0);
    const target = fields.find((f) => f !== store.getState().activeField) ?? fields[0];

    control("field").dispatchEvent(new MouseEvent("click"));
    const panel = popover();
    expect(panel).not.toBeNull();
    expect(panel?.querySelector(".webpic-popover_meta")).not.toBeNull(); // the metadata line
    const option = [...(panel?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
      (o) => o.dataset.value === target,
    );
    expect(option).toBeDefined();
    option?.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().activeField).toBe(target);
  });

  it("disables the time control with ≤1 step and scrubs once a domain loads", () => {
    const { store, control, slider } = setup();
    expect(slider().disabled).toBe(true);
    expect(control("step-prev").disabled).toBe(true);

    store.getState().setAvailableSteps([0, 5, 10]);
    expect(slider().disabled).toBe(false);
    expect(slider().max).toBe("2");

    slider().value = "2";
    slider().dispatchEvent(new Event("input"));
    expect(store.getState().currentStep).toBe(10); // index 2 → step 10 (sparse domain)
  });

  it("prev/next nudge the step by one index", () => {
    const { store, control } = setup();
    store.getState().setAvailableSteps([0, 5, 10]);
    store.getState().setStep(5);
    control("step-next").dispatchEvent(new MouseEvent("click"));
    expect(store.getState().currentStep).toBe(10);
    control("step-prev").dispatchEvent(new MouseEvent("click"));
    expect(store.getState().currentStep).toBe(5);
  });

  it("reflects an external setStep onto the slider value", () => {
    const { store, slider } = setup();
    store.getState().setAvailableSteps([0, 5, 10]);
    store.getState().setStep(10);
    expect(slider().value).toBe("2");
    expect(store.getState().currentStep).toBe(10); // no echo / runaway
  });

  it("hides the bar and closes popovers on the global UI toggle", () => {
    const { uiStore, control, bar, popover } = setup();
    control("dataset").dispatchEvent(new MouseEvent("click"));
    expect(popover()).not.toBeNull();
    uiStore.getState().toggleUi();
    expect(bar.hidden).toBe(true);
    expect(popover()).toBeNull(); // force-closed with the UI
  });

  it("removes the bar and its popover nodes on dispose", () => {
    const { parent, control, dispose } = setup();
    control("dataset").dispatchEvent(new MouseEvent("click")); // build the dataset popover
    control("field").dispatchEvent(new MouseEvent("click")); // build the field popover
    dispose();
    expect(parent.querySelector(".webpic-topbar")).toBeNull();
    expect(document.body.querySelector(".webpic-popover")).toBeNull();
  });
});
