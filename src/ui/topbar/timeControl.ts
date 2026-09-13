import type { SimulationStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import type { RangeValue } from "../controls/index.ts";
import { createRangeControl } from "../controls/rangeControl.ts";
import { stepAt, stepIndex, stepReadout } from "./info.ts";
import { makeStepButton, makeTopBarCaret } from "./parts.ts";

// A compact "step N" chip that reveals a scrub popover (track + prev/next), so the resting bar stays
// a single centered line. The range control bakes min/max/step at construction, so a changed domain
// rebuilds it; a cursor move reflects via set() without echo. Disabled (<=1 step) dims the chip and
// gates the reveal shut.

const ICON = {
  prev: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 3 6 8l5.5 5"/><path d="M5 3v10"/></svg>`,
  next: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3 10 8l-5.5 5"/><path d="M11 3v10"/></svg>`,
} as const;

export interface TimeControl {
  // The reveal wrapper the bar places and relocates when it goes compact.
  readonly element: HTMLElement;
  // The reveal's trigger, handed to bindReveal by the bar.
  readonly chip: HTMLButtonElement;
  // Rebuild the track against a changed `availableSteps` domain.
  rebuild(): void;
  // Reflect an externally-dispatched setStep onto the grip, without echoing onChange.
  syncCursor(): void;
  dispose(): void;
}

export function installTimeControl(doc: Document, store: SimulationStore): TimeControl {
  const element = makeEl(doc, "div", "webpic-topbar_time webpic-topbar_reveal");
  const chip = makeEl(doc, "button", "webpic-topbar_chip");
  chip.type = "button";
  chip.dataset.control = "time";
  chip.title = "Timestep";
  chip.setAttribute("aria-haspopup", "true");
  chip.setAttribute("aria-expanded", "false");
  const stepLabel = makeEl(doc, "span", "webpic-topbar_step");
  chip.append(stepLabel, makeTopBarCaret(doc));

  const pop = makeEl(doc, "div", "webpic-topbar_pop webpic-topbar_time-pop");
  const prevBtn = makeStepButton(doc, "step-prev", ICON.prev, "Previous step");
  const nextBtn = makeStepButton(doc, "step-next", ICON.next, "Next step");
  pop.append(prevBtn, nextBtn); // the scrub track is inserted between them by rebuild()
  element.append(chip, pop);

  let range: ReturnType<typeof createRangeControl> | null = null;
  let steps: readonly number[] = []; // the availableSteps snapshot the live control was built against

  const dispatchIndex = (index: number): void => {
    const step = stepAt(index, steps);
    if (step !== undefined) store.getState().setStep(step); // self-guards out-of-domain + no-ops
  };
  // The grip is a focusable <div role="slider">, not an <input>, so bare-key shortcuts (F/C) reach
  // the document handlers while it's focused — unlike a native <input> slider.
  const onScrub = (v: RangeValue): void => {
    if (typeof v !== "number") return; // single mode emits a number
    stepLabel.textContent = stepReadout(v, steps); // live readout in the resting chip
    dispatchIndex(v);
  };

  const rebuild = (): void => {
    range?.dispose();
    steps = store.getState().availableSteps;
    const index = stepIndex(store.getState().currentStep, steps);
    range = createRangeControl(doc, {
      min: 0,
      max: Math.max(0, steps.length - 1),
      value: index,
      step: 1,
      hasText: false, // bare track + grip; the readout is the chip's stepLabel, not a coupled field
      format: (i) => stepReadout(i, steps), // aria-valuetext announces "step 10", not the bare index
      onInput: onScrub,
      onChange: onScrub,
    });
    range.element.classList.add("webpic-topbar_track");
    const isDisabled = steps.length <= 1;
    range.setDisabled(isDisabled);
    pop.insertBefore(range.element, nextBtn); // keep [prev, track, next] inside the popover
    prevBtn.disabled = isDisabled;
    nextBtn.disabled = isDisabled;
    chip.disabled = isDisabled;
    element.classList.toggle("is-disabled", isDisabled); // dims the chip + gates the reveal (CSS)
    stepLabel.textContent = stepReadout(index, steps);
  };

  const stepBy = (delta: number): void => {
    dispatchIndex(stepIndex(store.getState().currentStep, steps) + delta);
  };
  prevBtn.addEventListener("click", () => stepBy(-1));
  nextBtn.addEventListener("click", () => stepBy(1));

  return {
    element,
    chip,
    rebuild,
    syncCursor() {
      const index = stepIndex(store.getState().currentStep, steps);
      range?.set(index);
      stepLabel.textContent = stepReadout(index, steps);
    },
    dispose() {
      range?.dispose();
    },
  };
}
