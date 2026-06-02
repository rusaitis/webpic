import { DEFAULT_WEBPIC_CONFIG, type Theme } from "@schema/theme.ts";
import type { SimulationStore, UiStore } from "@store";
import type { Disposer } from "./controls/index.ts";
import { installFieldPanel } from "./panels/fieldPanel.ts";
import { installPlaceholderPanel } from "./panels/placeholderPanel.ts";
import { createShell } from "./shell/shell.ts";
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

function mountPanel(name: string, host: HTMLElement, store: SimulationStore): Disposer {
  switch (name) {
    case "field":
      return installFieldPanel(host, store);
    case "layers":
      return installPlaceholderPanel(host, "Layers", "No layers yet");
    case "diagnostics":
      return installPlaceholderPanel(host, "Diagnostics", "GPU timing — coming soon");
    default:
      return installPlaceholderPanel(host, name, "Coming soon");
  }
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

  // Global UI toggle bound to the theme's bare-key shortcut (default "F"); ignore it while
  // typing in a control and when modifiers are held (those are reserved for the palette).
  const toggleKey = shortcuts.toggleUi.toLowerCase();
  const doc = opts.parent.ownerDocument;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (event.key.toLowerCase() === toggleKey) opts.uiStore.getState().toggleUi();
  };
  doc.addEventListener("keydown", onKeyDown);
  disposers.push(() => doc.removeEventListener("keydown", onKeyDown));

  // LIFO teardown: shortcut → panels → shell → styles, mirroring install order.
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
