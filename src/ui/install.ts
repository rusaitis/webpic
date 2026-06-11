import { DEFAULT_WEBPIC_CONFIG, type Theme } from "@schema/theme.ts";
import type { SimulationStore, UiStore } from "@store";
import { installCameraChrome } from "./cameraChrome.ts";
import type { Disposer } from "./controls/index.ts";
import { isTypingTarget } from "./keyboard.ts";
import { mountPanel } from "./panels/registry.ts";
import { createShell } from "./shell/shell.ts";
import { installStatusPill } from "./statusPill.ts";
import { applyControlStyles } from "./theme/styles.ts";

// The UI subsystem's install entry (install*() => () => void): styles + docked shell +
// panels + the global show/hide shortcut. Dispatches store intents and subscribes — never
// imports render. `theme` is optional — layout/shortcuts/colors fall back to defaults.

export interface InstallUiOptions {
  readonly parent: HTMLElement;
  readonly simulationStore: SimulationStore;
  readonly uiStore: UiStore;
  readonly theme?: Theme;
}

export function installUi(opts: InstallUiOptions): () => void {
  const layout = opts.theme?.webpic.layout ?? DEFAULT_WEBPIC_CONFIG.layout;
  const shortcuts = opts.theme?.webpic.shortcuts ?? DEFAULT_WEBPIC_CONFIG.shortcuts;
  const panels = layout.defaultPanels;

  const disposers: Disposer[] = [];
  disposers.push(applyControlStyles(opts.parent, opts.theme?.colors));

  const shell = createShell({
    parent: opts.parent,
    dockedSide: layout.dockedSide,
    panels,
    uiStore: opts.uiStore,
  });
  disposers.push(() => shell.dispose());

  for (const name of panels) {
    disposers.push(mountPanel(name, shell.panelHost(name), opts.simulationStore));
  }

  // The camera HUD (readout + gnomon) is a fixed bottom-left overlay, not a docked panel — it sits
  // outside the shell so it stays put when panels collapse, and hides with the global UI toggle.
  disposers.push(installCameraChrome(opts.parent, opts.simulationStore, opts.uiStore));

  // Loading/error feedback; unlike the chrome it ignores the global UI toggle — status, not chrome.
  disposers.push(installStatusPill(opts.parent, opts.uiStore));

  // Global UI toggle bound to the theme's bare-key shortcut (default "F"); ignore it while
  // typing in a control and when modifiers are held (those are reserved for the palette).
  const toggleKey = shortcuts.toggleUi.toLowerCase();
  const doc = opts.parent.ownerDocument;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    if (isTypingTarget(event.target)) return;
    if (event.key.toLowerCase() === toggleKey) opts.uiStore.getState().toggleUi();
  };
  doc.addEventListener("keydown", onKeyDown);
  disposers.push(() => doc.removeEventListener("keydown", onKeyDown));

  // LIFO teardown: shortcut → panels → shell → styles, mirroring install order. Snapshot
  // so a defensive double-dispose can't re-reverse the live array.
  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
