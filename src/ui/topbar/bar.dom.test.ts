import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { vectorTriple } from "../../../tests/fixtures.ts";
import { installTopBar } from "./bar.ts";

// happy-dom: the time scrub is driven via keyboard (no geometry for pointer drags), so assertions hit
// the ui → store seam (setStep) plus the rendered readout.
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
    const element = bar.querySelector<HTMLButtonElement>(`[data-control="${c}"]`);
    if (element === null) throw new Error(`missing control: ${c}`);
    return element;
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
  it("mounts the brand, pickers, time chip + scrub track, projection/export, and the placeholders", () => {
    const { bar, control, range, valueGrip } = setup();
    expect(bar.querySelector(".webpic-topbar_brand")?.textContent).toContain("webpic");
    expect(control("dataset")).toBeInstanceOf(window.HTMLButtonElement);
    expect(control("field")).toBeInstanceOf(window.HTMLButtonElement);
    expect(range()).not.toBeNull();
    expect(valueGrip()).not.toBeNull();
    for (const c of ["time", "step-prev", "step-next", "more"]) {
      expect(control(c)).toBeInstanceOf(window.HTMLButtonElement);
    }
    expect(control("projection").disabled).toBe(false); // live bar controls, not placeholders
    expect(control("export").disabled).toBe(false);
    for (const c of ["upload", "layers", "layout"]) {
      expect(control(c).disabled).toBe(true);
      expect(control(c).getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("dispatches requestScreenshot on export click", () => {
    const { uiStore, control } = setup();
    const before = uiStore.getState().screenshotSerial;
    control("export").dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().screenshotSerial).toBe(before + 1);
  });

  it("shows the projection on the chip and toggles it through the store", () => {
    const { store, control } = setup();
    const chip = control("projection");
    expect(chip.textContent).toBe("persp");
    chip.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().projection).toBe("orthographic");
    expect(chip.textContent).toBe("ortho");
    store.getState().setProjection("perspective"); // external flip (rail button, O key) reflects
    expect(chip.textContent).toBe("persp");
  });

  it("prefers the loaded dataset's run name for the dataset label", () => {
    const { store, control } = setup();
    expect(control("dataset").textContent).toContain("Flux rope"); // catalog label pre-load
    const dataset = vectorTriple("B", { array: Float32Array });
    void store.getState().setDataset({ ...dataset, metadata: { run: { name: "run-001" } } });
    expect(control("dataset").textContent).toContain("run-001");
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

  it("keeps the pinned action reveal open on outside pointerdown, toggling shut on re-click", () => {
    const { control, actionsReveal } = setup();
    const chevron = control("more");
    chevron.dispatchEvent(new MouseEvent("click")); // pin
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(true);
    // a scene click does not dismiss a pinned panel (sticky like the time scrub)
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(true);
    chevron.dispatchEvent(new MouseEvent("click")); // re-click is the way to close it
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(false);
  });

  it("keeps the dataset popover open on outside pointerdown (sticky select)", () => {
    const { control, popover } = setup();
    control("dataset").dispatchEvent(new MouseEvent("click"));
    expect(popover()).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(popover()).not.toBeNull(); // sticky — scene click leaves it open
  });

  it("makes overlays mutually exclusive — opening one closes the others", () => {
    const { control, actionsReveal, popover } = setup();
    control("dataset").dispatchEvent(new MouseEvent("click")); // open the picker
    expect(popover()).not.toBeNull();
    control("more").dispatchEvent(new MouseEvent("click")); // opening the chevron closes the picker
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(true);
    expect(popover()).toBeNull();
    expect(control("dataset").getAttribute("aria-expanded")).toBe("false");
    control("dataset").dispatchEvent(new MouseEvent("click")); // reopening the picker closes the chevron
    expect(popover()).not.toBeNull();
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

  it("clears the pinned reveal when the bar is hidden", () => {
    const { uiStore, control, actionsReveal } = setup();
    control("more").dispatchEvent(new MouseEvent("click"));
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(true);

    uiStore.getState().toggleUi();
    expect(actionsReveal()?.classList.contains("is-expanded")).toBe(false); // not restored on re-show
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
