import type { SimulationStore } from "@store";
import {
  type ControlHandle,
  createPane,
  type Disposer,
  type RangeValue,
} from "../controls/index.ts";

// The Time panel: a scrub RangeControl over the discrete timestep domain. It dispatches setStep
// (ui → store; never render); the streaming worker reacts to currentStep by reading + uploading
// the next field.
//
// The control walks *indices* into availableSteps, not the step numbers themselves: every grip
// position maps to a real step (robust to sparse/non-contiguous steps, and free of snapping), while
// the readout shows the step value. For the common contiguous-from-zero domain ([0,1,2,…]) index ≡
// step, so text entry reads naturally too.

export function installTimePanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Time" });
  const folder = pane.addFolder({ title: "Timestep" });

  let control: ControlHandle<RangeValue> | null = null;
  // The availableSteps snapshot the live control was built against — the index↔step map both ways.
  let steps: readonly number[] = [];

  const stepLabel = (index: number): string => {
    const step = steps[Math.round(index)];
    return step === undefined ? "—" : `step ${step}`;
  };

  const indexOfCurrent = (): number => {
    const i = steps.indexOf(store.getState().currentStep);
    return i < 0 ? 0 : i;
  };

  const dispatch = (v: RangeValue): void => {
    if (typeof v !== "number") return; // single mode emits a number
    const step = steps[Math.round(v)];
    if (step !== undefined) store.getState().setStep(step);
  };

  // RangeControl bakes min/max/step at construction, so a changed domain means a fresh control.
  // Disabled with 0/1 steps — there's nothing to scrub.
  const rebuild = (): void => {
    control?.dispose();
    steps = store.getState().availableSteps;
    control = folder.addRangeControl({
      label: "Step",
      min: 0,
      max: Math.max(0, steps.length - 1),
      value: indexOfCurrent(),
      step: 1,
      format: stepLabel,
      onInput: dispatch,
      onChange: dispatch,
    });
    control.setDisabled(steps.length <= 1);
  };

  rebuild();

  const unsubSteps = store.subscribe((s) => s.availableSteps, rebuild);
  // Reflect an externally-dispatched setStep without echoing onChange (set()-in / callbacks-out).
  const unsubStep = store.subscribe(
    (s) => s.currentStep,
    () => control?.set(indexOfCurrent()),
  );

  return () => {
    unsubStep();
    unsubSteps();
    pane.dispose(); // disposes the live control too (rebuild() owns swap-time disposal)
  };
}
