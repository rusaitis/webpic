import type { UiStore } from "@store";
import type { Subscriptions } from "./subscriptions.ts";

// Every chrome surface hides with the global UI toggle (F); one that also has its own open flag is
// visible only when both say so. The AND, the initial apply and the store re-read live here, so no
// surface spells them a second way. `bind*`, not `install*`: what comes back is the re-apply
// function — a surface with its own flag subscribes that flag to this same computation — and an
// install returns a disposer, so calling this one as if it were teardown would do the opposite.
export function bindChromeVisibility(
  subscriptions: Subscriptions,
  uiStore: UiStore,
  show: (isVisible: boolean) => void,
  isOpen: () => boolean = () => true,
): () => void {
  const apply = (): void => show(uiStore.getState().isUiVisible && isOpen());
  subscriptions.on(uiStore, (state) => state.isUiVisible, apply, { shouldFireNow: true });
  return apply;
}

// A floating window's visibility: the same store rule, driving show/hide instead of a class. Both
// windows (Developer, Layer settings) mount this way.
export function bindWindowVisibility(
  subscriptions: Subscriptions,
  uiStore: UiStore,
  win: { show(): void; hide(): void },
  isOpen: () => boolean,
): () => void {
  return bindChromeVisibility(
    subscriptions,
    uiStore,
    (isVisible) => {
      if (isVisible) win.show();
      else win.hide();
    },
    isOpen,
  );
}
