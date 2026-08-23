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
// Visibility is the `panels.dev` flag, default *closed*: it is a developer instrument, and an
// open dev window is the wrong first frame for someone who just opened the app. The rail's
// Diagnostics button toggles it and the header × clears it, both without the F UI toggle.

export function installDevWindow(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const win = createFloatingWindow({
    parent,
    title: "Developer",
    onClose: () => uiStore.getState().setPanelVisible("dev", false),
  });
  // GPU frame-time readout + "Measure (continuous)" — the sustained per-frame instrument the
  // raymarch perf gate (and scripts/profile-raymarch.ts) drives. Orphaned when the docked shell stopped
  // mounting default panels; re-homed here so the dev tool still has a measurement surface.
  const disposeDiagnostics = installDiagnosticsPanel(win.body, store);
  const disposePanel = installDevPanel(win.body, store);

  // Shown when the UI is visible AND the dev window has been opened from the rail.
  const applyVisible = (): void => {
    const ui = uiStore.getState();
    if (ui.isUiVisible && (ui.panels.dev ?? false)) win.show();
    else win.hide();
  };
  applyVisible();
  const unsubs = [
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
    uiStore.subscribe((s) => s.panels.dev, applyVisible),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
    disposePanel();
    disposeDiagnostics();
    win.dispose();
  };
}
