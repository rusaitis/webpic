import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { installTopBar } from "./topBar.ts";

// happy-dom: the time scrub is driven via keyboard (no geometry for pointer drags), so assertions hit
// the ui → store seam (setStep) plus the rendered readout — mirroring ui/panels/timePanel's tests.
// The scrub track + prev/next live in a CSS-hidden reveal popover, but happy-dom queries + event
// dispatch reach hidden nodes, so the behavioral assertions don't depend on the popover being open.

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
  const range = (): HTMLElement | null => bar.querySelector<HTMLElement>(".webpic-range");
  const valueGrip = (): HTMLElement | null =>
    bar.querySelector<HTMLElement>('.webpic-range_grip[data-end="value"]');
  const stepText = (): string => bar.querySelector(".webpic-topbar_step")?.textContent ?? "";
  // Two reveals share the .webpic-topbar_reveal class, so reach each via its trigger.
  const timeReveal = (): HTMLElement | null =>
    control("time").closest<HTMLElement>(".webpic-topbar_reveal");
  const actionsReveal = (): HTMLElement | null =>
    control("more").closest<HTMLElement>(".webpic-topbar_reveal");
  const popover = (): HTMLElement | null =>
    [...document.body.querySelectorAll<HTMLElement>(".webpic-popover")].find((p) => !p.hidden) ??
    null;
  return {
    parent,
    store,
    uiStore,
    bar,
    control,
    range,
    valueGrip,
    stepText,
    timeReveal,
    actionsReveal,
    popover,
    dispose,
  };
}

describe("installTopBar", () => {
  it("mounts the brand, pickers, time chip + scrub track, and four placeholders behind the chevron", () => {
    const { bar, control, range, valueGrip } = setup();
    expect(bar.querySelector(".webpic-topbar_brand")?.textContent).toContain("webpic");
    expect(control("dataset")).toBeInstanceOf(window.HTMLButtonElement);
    expect(control("field")).toBeInstanceOf(window.HTMLButtonElement);
    expect(range()).not.toBeNull();
    expect(valueGrip()).not.toBeNull();
    for (const c of ["time", "step-prev", "step-next", "more"]) {
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
    const { store, control, range, valueGrip } = setup();
    expect(range()?.classList.contains("is-disabled")).toBe(true);
    expect(control("time").disabled).toBe(true);
    expect(control("step-prev").disabled).toBe(true);

    store.getState().setAvailableSteps([0, 5, 10]); // domain → rebuild a fresh, enabled control
    expect(range()?.classList.contains("is-disabled")).toBe(false);
    expect(control("time").disabled).toBe(false);
    expect(control("step-prev").disabled).toBe(false);

    const grip = valueGrip();
    if (grip === null) throw new Error("scrub needs a value grip");
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(store.getState().currentStep).toBe(5); // index 0 → 1 → step 5 (sparse domain)
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

  it("reflects an external setStep onto the step chip readout without echo", () => {
    const { store, stepText } = setup();
    store.getState().setAvailableSteps([0, 5, 10]);
    store.getState().setStep(10);
    expect(stepText()).toBe("step 10"); // text:false → the readout is the chip label, not an input
    expect(store.getState().currentStep).toBe(10); // no echo / runaway
  });

  it("pins the time scrub reveal on chip click and closes it on Escape", () => {
    const { store, control, timeReveal } = setup();
    store.getState().setAvailableSteps([0, 5, 10]); // enable the chip (≥2 steps)
    const chip = control("time");
    expect(chip.disabled).toBe(false);
    expect(timeReveal()?.classList.contains("is-expanded")).toBe(false);

    chip.dispatchEvent(new MouseEvent("click"));
    expect(timeReveal()?.classList.contains("is-expanded")).toBe(true);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(timeReveal()?.classList.contains("is-expanded")).toBe(false);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("pins the action reveal on chevron click and closes it on Escape", () => {
    const { control, actionsReveal } = setup();
    const chevron = control("more");
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(false);
    expect(chevron.getAttribute("aria-expanded")).toBe("false");

    chevron.dispatchEvent(new MouseEvent("click"));
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(true);
    expect(chevron.getAttribute("aria-expanded")).toBe("true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(false);
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the pinned time reveal open on outside pointerdown (sticky scrub)", () => {
    const { store, control, timeReveal } = setup();
    store.getState().setAvailableSteps([0, 5, 10]);
    control("time").dispatchEvent(new MouseEvent("click")); // pin
    expect(timeReveal()?.classList.contains("is-expanded")).toBe(true);
    // interacting with the scene (outside the bar) must NOT dismiss a pinned scrubber
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(timeReveal()?.classList.contains("is-expanded")).toBe(true);
  });

  it("closes the pinned action reveal on outside pointerdown (menu)", () => {
    const { control, actionsReveal } = setup();
    control("more").dispatchEvent(new MouseEvent("click")); // pin
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(true);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(false);
  });

  it("hides the bar and closes popovers on the global UI toggle", () => {
    const { uiStore, control, bar, popover } = setup();
    control("dataset").dispatchEvent(new MouseEvent("click"));
    expect(popover()).not.toBeNull();
    uiStore.getState().toggleUi();
    expect(bar.hidden).toBe(true);
    expect(popover()).toBeNull(); // force-closed with the UI
  });

  it("clears both pinned reveals when the bar is hidden", () => {
    const { store, uiStore, control, timeReveal, actionsReveal } = setup();
    store.getState().setAvailableSteps([0, 5, 10]); // enable the time chip
    control("time").dispatchEvent(new MouseEvent("click"));
    control("more").dispatchEvent(new MouseEvent("click"));
    expect(timeReveal()?.classList.contains("is-expanded")).toBe(true);
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(true);

    uiStore.getState().toggleUi();
    expect(timeReveal()?.classList.contains("is-expanded")).toBe(false); // not restored on re-show
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(false);
  });

  it("removes the bar, its popovers, and the scrub control on dispose", () => {
    const { parent, control, range, dispose } = setup();
    control("dataset").dispatchEvent(new MouseEvent("click")); // build the dataset popover
    control("field").dispatchEvent(new MouseEvent("click")); // build the field popover
    expect(range()).not.toBeNull();
    dispose();
    expect(parent.querySelector(".webpic-topbar")).toBeNull();
    expect(document.body.querySelector(".webpic-popover")).toBeNull();
    expect(parent.querySelector(".webpic-range")).toBeNull(); // the rebuilt control torn down too
  });
});
