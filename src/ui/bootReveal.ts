import { BOOT_PHASE_KEY, type LoadingPhase, type UiStore } from "@store";
import type { Disposer } from "./controls/index.ts";
import { createSubscriptions } from "./subscriptions.ts";

// Cold-start reveal: the chrome mounts under
// `webpic-booting` — held at opacity 0 / visibility hidden by styles.ts — and fades in
// when the boot phase ends, so panels never float over the blank pre-first-frame canvas.
// One-way: later loads (opens, scrubs) never re-hide the UI. The status pill is exempt
// by selector — it's the feedback during the hidden window.

export const BOOTING_CLASS = "webpic-booting";

const isBooting = (phases: readonly LoadingPhase[]): boolean =>
  phases.some((phase) => phase.key === BOOT_PHASE_KEY);

export function installBootReveal(parent: HTMLElement, uiStore: UiStore): Disposer {
  if (!isBooting(uiStore.getState().loadingPhases)) return () => {};

  parent.classList.add(BOOTING_CLASS);
  const reveal = (): void => parent.classList.remove(BOOTING_CLASS);
  const subscriptions = createSubscriptions();
  subscriptions.on(
    uiStore,
    (state) => state.loadingPhases,
    (phases) => {
      if (!isBooting(phases)) {
        reveal();
        subscriptions.dispose(); // one-shot: the reveal never re-arms
      }
    },
  );
  return () => {
    subscriptions.dispose();
    reveal();
  };
}
