import type { SimulationStore, UiStore } from "@store";
import type { Disposer } from "../controls/index.ts";
import { createFloatingWindow } from "../floating/floatingWindow.ts";
import { installDevPanel } from "./devPanel.ts";

// The Developer tool as a small, free-floating window (grip-dragged, corner-resized) rather than a
// full-height docked panel. Reuses the createFloatingWindow template for the chrome and installDevPanel
// for the contents; hides with the global UI toggle, like the colorbar. Opens compact in the top-right
// (the window's defaults), where the docked panel used to sit. The header × dismisses it; toggling the
// UI off and back on (F) brings it back — ephemeral, no persisted closed state.

export function installDevWindow(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const win = createFloatingWindow({ parent, title: "Developer", onClose: () => win.hide() });
  const disposePanel = installDevPanel(win.body, store);

  const applyVisible = (visible: boolean): void => {
    if (visible) win.show();
    else win.hide();
  };
  applyVisible(uiStore.getState().isUiVisible);
  const unsubVisible = uiStore.subscribe((s) => s.isUiVisible, applyVisible);

  return () => {
    unsubVisible();
    disposePanel();
    win.dispose();
  };
}
