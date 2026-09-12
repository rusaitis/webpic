import type { UiStore } from "@store";
import type { Subscriptions } from "./subscriptions.ts";

// Every chrome surface hides with the global UI toggle (F); one that also has its own open flag is
// visible only when both say so. The AND, the initial apply and the store re-read live here, so no
// surface spells them a second way. Returns the re-apply function: a surface with its own flag
// subscribes that flag to this same computation.
export function installChromeVisibility(
  subscriptions: Subscriptions,
  uiStore: UiStore,
  show: (isVisible: boolean) => void,
  isOpen: () => boolean = () => true,
): () => void {
  const apply = (): void => show(uiStore.getState().isUiVisible && isOpen());
  subscriptions.on(uiStore, (state) => state.isUiVisible, apply, { shouldFireNow: true });
  return apply;
}
