import type { SimulationStore, UiStore } from "@store";
import type { Disposer } from "../controls/index.ts";
import { createFloatingWindow } from "../floating/floatingWindow.ts";
import { installDevPanel } from "./devPanel.ts";
import { installDiagnosticsPanel } from "./diagnosticsPanel.ts";

// The Developer tool as a small, free-floating window (grip-dragged, corner-resized) rather than a
// full-height docked panel. Reuses the createFloatingWindow template for the chrome and hosts the
// in-development controls: the GPU frame-time diagnostics (the 8 ms raymarch-gate instrument + its
// sustained-measurement toggle) and the volume Phong toggle. Hides with the global UI toggle, like the
// colorbar. Opens compact in the top-right (the window's defaults), where the docked panel used to sit.
// The header × dismisses it; toggling the UI off and back on (F) brings it back — ephemeral, no
// persisted closed state.

export function installDevWindow(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const win = createFloatingWindow({ parent, title: "Developer", onClose: () => win.hide() });
  // GPU frame-time readout + "Measure (continuous)" — the sustained per-frame instrument the M2
  // raymarch gate (and scripts/profile-raymarch.ts) drives. Orphaned when the docked shell stopped
  // mounting default panels; re-homed here so the dev tool still has a measurement surface.
  const disposeDiagnostics = installDiagnosticsPanel(win.body, store);
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
    disposeDiagnostics();
    win.dispose();
  };
}
