import { DEFAULT_WEBPIC_CONFIG, type Theme } from "@schema/theme.ts";
import type { PerfStore, SimulationStore, UiStore } from "@store";
import { installBootReveal } from "./bootReveal.ts";
import { installCameraChrome } from "./cameraChrome.ts";
import { installCameraRail } from "./cameraRail.ts";
import { installColorbar } from "./colorbar/colorbar.ts";
import { installHelpOverlay } from "./helpOverlay.ts";
import { installLayerSettings } from "./layerSettings.ts";
import { installLayersPanel } from "./layersPanel.ts";
import { installDevWindow } from "./panels/devWindow.ts";
import { isDockable, mountPanel } from "./panels/registry.ts";
import { createShell } from "./shell/shell.ts";
import { createShortcutRegistry } from "./shortcuts.ts";
import { installSideRail } from "./sideRail.ts";
import { installStatusPill } from "./statusPill.ts";
import { createSubscriptions } from "./subscriptions.ts";
import { applyControlStyles } from "./theme/styles.ts";
import { installTopBar } from "./topBar.ts";

// The UI subsystem's install entry (install*() => () => void): styles + docked shell +
// panels + the global show/hide shortcut. Dispatches store intents and subscribes — never
// imports render. `theme` is optional — layout/shortcuts/colors fall back to defaults.

export interface InstallUiOptions {
  readonly parent: HTMLElement;
  readonly simulationStore: SimulationStore;
  // Render timing for the Developer window's frame-timing panel (+ the dev HUD when enabled).
  readonly perfStore: PerfStore;
  readonly uiStore: UiStore;
  readonly theme?: Theme;
}

export function installUi(options: InstallUiOptions): () => void {
  const layout = options.theme?.webpic.layout ?? DEFAULT_WEBPIC_CONFIG.layout;
  const shortcuts = options.theme?.webpic.shortcuts ?? DEFAULT_WEBPIC_CONFIG.shortcuts;
  const panels = layout.defaultPanels.filter(isDockable);

  const subscriptions = createSubscriptions();
  subscriptions.add(applyControlStyles(options.parent, options.theme));

  // Class on before the chrome mounts, so it never flashes over the blank boot canvas.
  subscriptions.add(installBootReveal(options.parent, options.uiStore));

  // The docked shell renders only when something is docked — an empty shell would show as a bare
  // glass box. Floating chrome (colorbar, Developer window) lives outside it.
  if (panels.length > 0) {
    const shell = createShell({
      parent: options.parent,
      dockedSide: layout.dockedSide,
      panels,
      uiStore: options.uiStore,
    });
    subscriptions.add(() => shell.dispose());
    for (const name of panels) {
      subscriptions.add(mountPanel(name, shell.panelHost(name), options.simulationStore));
    }
  }

  // Fixed top menu bar — dataset/field pickers + time scrub + placeholder actions. Outside the shell
  // (it spans the top edge), UI-toggle-hidden. It owns dataset/field/time, so those drop from the
  // default docked panels (schema/theme defaultPanels).
  subscriptions.add(installTopBar(options.parent, options.simulationStore, options.uiStore));

  // The camera gnomon is a fixed bottom-left overlay, not a docked panel — it sits outside the shell
  // so it stays put when panels collapse, and hides with the global UI toggle.
  subscriptions.add(installCameraChrome(options.parent, options.simulationStore, options.uiStore));

  // The centered bottom button rail (gnomon/fly/projection/coord/help) — also outside the shell, also
  // UI-toggle-hidden. It reserves the gnomon's footprint so the two never collide.
  subscriptions.add(installCameraRail(options.parent, options.simulationStore, options.uiStore));

  // The left tool rail — View (toggles the Scene panel) + Probe (the point marker), the instance-first
  // rail's first occupants on the operations axis. Outside the shell on the left edge, UI-toggle-
  // hidden; the layer add-buttons and the tool tabs mount here too. The gnomon stays on the bottom rail.
  subscriptions.add(installSideRail(options.parent, options.simulationStore, options.uiStore));

  // The Layers overlay — the rail-toggled, fixed translucent panel of renderable instances (one row
  // per layer: eye / select / reorder). Mounts next to the rail's interaction cluster; owns the "L"
  // shortcut. UI-toggle-hidden, like the rail.
  subscriptions.add(installLayersPanel(options.parent, options.simulationStore, options.uiStore));

  // The per-layer settings window — one component opened from the Layers-panel gear or the rail's
  // "Add new", bound to the selected layer (field/colormap/window/opacity/order/remove + kind-specific).
  // Free-floating + UI-toggle-hidden like the colorbar/Developer window.
  subscriptions.add(installLayerSettings(options.parent, options.simulationStore, options.uiStore));

  // The floating colorbar — the selected layer's color mapping as a draggable, edge-snapping
  // gradient strip; its gear opens the colormap/scale/window controls. Supersedes the docked
  // colormap panel. Outside the shell on a free-floating layer, UI-toggle-hidden.
  subscriptions.add(installColorbar(options.parent, options.simulationStore, options.uiStore));

  // The Developer tool — a small, free-floating, resizable window.
  // Outside the shell on a free-floating layer, UI-toggle-hidden, like the colorbar.
  subscriptions.add(
    installDevWindow(options.parent, options.simulationStore, options.perfStore, options.uiStore),
  );

  // Loading/error feedback; unlike the chrome it ignores the global UI toggle — status, not chrome.
  subscriptions.add(installStatusPill(options.parent, options.uiStore));

  // Keyboard cheat-sheet modal (? / H). Its own keydown listener — independent of the UI toggle.
  subscriptions.add(installHelpOverlay(options.parent, options.uiStore));

  // Global bare-key shortcuts: the theme's UI toggle (default "F"), the PNG screenshot ("P"), and
  // the add-field-lines layer intent ("T", DESIGN §Shortcuts). Unshifted only — Shift+P is the perf
  // HUD's. The camera's view keys and the panels' toggles register on their own registries.
  const registry = createShortcutRegistry(options.parent.ownerDocument);
  registry.register(shortcuts.toggleUi, () => options.uiStore.getState().toggleUi());
  registry.register("p", () => options.uiStore.getState().requestScreenshot());
  registry.register("t", () => options.simulationStore.getState().addFieldlinesLayer());
  subscriptions.add(() => registry.dispose());

  // LIFO teardown mirroring install order: shortcuts → chrome → panels → shell → styles.
  return () => subscriptions.dispose();
}
