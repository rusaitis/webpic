import { DEFAULT_WEBPIC_CONFIG, type Theme } from "@schema/theme.ts";
import type { SimulationStore, UiStore } from "@store";
import { installBootReveal } from "./bootReveal.ts";
import { installCameraChrome } from "./cameraChrome.ts";
import { installCameraRail } from "./cameraRail.ts";
import { installColorbar } from "./colorbar/colorbar.ts";
import type { Disposer } from "./controls/index.ts";
import { installHelpOverlay } from "./helpOverlay.ts";
import { isTypingTarget } from "./keyboard.ts";
import { mountPanel } from "./panels/registry.ts";
import { createShell } from "./shell/shell.ts";
import { installSideRail } from "./sideRail.ts";
import { installStatusPill } from "./statusPill.ts";
import { applyControlStyles } from "./theme/styles.ts";
import { installTopBar } from "./topBar.ts";

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

  // Class on before the chrome mounts, so it never flashes over the blank boot canvas.
  disposers.push(installBootReveal(opts.parent, opts.uiStore));

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

  // Fixed top menu bar — dataset/field pickers + time scrub + placeholder actions. Outside the shell
  // (it spans the top edge), UI-toggle-hidden. It owns dataset/field/time, so those drop from the
  // default docked panels (schema/theme defaultPanels).
  disposers.push(installTopBar(opts.parent, opts.simulationStore, opts.uiStore));

  // The camera gnomon is a fixed bottom-left overlay, not a docked panel — it sits outside the shell
  // so it stays put when panels collapse, and hides with the global UI toggle.
  disposers.push(installCameraChrome(opts.parent, opts.simulationStore, opts.uiStore));

  // The centered bottom button rail (gnomon/fly/projection/coord/help) — also outside the shell, also
  // UI-toggle-hidden. It reserves the gnomon's footprint so the two never collide.
  disposers.push(installCameraRail(opts.parent, opts.simulationStore, opts.uiStore));

  // The left tool rail — View (toggles the Scene panel) + Probe (the point marker), the instance-first
  // rail's first occupants on the operations axis. Outside the shell on the left edge, UI-toggle-
  // hidden; layer add-buttons + more tools land here in M4. The gnomon stays on the bottom rail.
  disposers.push(installSideRail(opts.parent, opts.simulationStore, opts.uiStore));

  // The floating colorbar — the selected layer's color mapping as a draggable, edge-snapping
  // gradient strip; its gear opens the colormap/scale/window controls. Replaces the old docked
  // colormap panel. Outside the shell on a free-floating layer, UI-toggle-hidden.
  disposers.push(installColorbar(opts.parent, opts.simulationStore, opts.uiStore));

  // Loading/error feedback; unlike the chrome it ignores the global UI toggle — status, not chrome.
  disposers.push(installStatusPill(opts.parent, opts.uiStore));

  // Keyboard cheat-sheet modal (? / H). Its own keydown listener — independent of the UI toggle.
  disposers.push(installHelpOverlay(opts.parent, opts.uiStore));

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
