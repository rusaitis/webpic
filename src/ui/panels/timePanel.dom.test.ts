import { createSimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installTimePanel } from "./timePanel.ts";

// happy-dom: drives the scrub control via keyboard (happy-dom has no geometry for pointer drags) and
// asserts the ui → store seam (setStep) plus set()-in reflection, matching the field/colormap panels.

afterEach(() => {
  document.body.replaceChildren();
});

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

const range = (h: HTMLElement) => h.querySelector<HTMLElement>(".webpic-range");
const valueGrip = (h: HTMLElement) =>
  h.querySelector<HTMLElement>('.webpic-range_grip[data-end="value"]');

describe("time panel (wired)", () => {
  it("disables the scrub with an empty/single-step domain and enables it once the domain grows", () => {
    const h = host();
    const store = createSimulationStore(); // availableSteps = []
    const dispose = installTimePanel(h, store);
    expect(range(h)?.classList.contains("is-disabled")).toBe(true);

    store.getState().setAvailableSteps([0, 1, 2, 3]); // domain → rebuild a fresh, enabled control
    expect(range(h)?.classList.contains("is-disabled")).toBe(false);

    dispose();
    expect(h.querySelector(".webpic-pane")).toBeNull();
  });

  it("dispatches setStep on scrub and reflects an external setStep without echo", () => {
    const h = host();
    const store = createSimulationStore();
    store.getState().setAvailableSteps([0, 1, 2, 3]);
    const dispose = installTimePanel(h, store);

    const grip = valueGrip(h);
    if (grip === null) throw new Error("scrub needs a value grip");
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(store.getState().currentStep).toBe(1); // index 0 → 1 → setStep(steps[1])

    store.getState().setStep(3); // dispatched elsewhere → control reflects it (readout shows the step)
    expect(h.querySelector<HTMLInputElement>(".webpic-range_input")?.value).toBe("step 3");

    dispose();
    expect(valueGrip(h)).toBeNull();
  });

  it("maps grip indices to sparse step numbers via the readout", () => {
    const h = host();
    const store = createSimulationStore();
    store.getState().setAvailableSteps([0, 10, 20]); // non-contiguous: index ≠ step
    const dispose = installTimePanel(h, store);

    const grip = valueGrip(h);
    if (grip === null) throw new Error("scrub needs a value grip");
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(store.getState().currentStep).toBe(10); // index 1 → step 10, no snapping needed
    expect(h.querySelector<HTMLInputElement>(".webpic-range_input")?.value).toBe("step 10");

    dispose();
  });
});
