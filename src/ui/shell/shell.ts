import type { UiStore } from "@store";

// Docked, hideable panel container: one host element per panel name. `isUiVisible` hides
// the whole shell, per-panel visibility hides individual hosts. Reads `uiStore` only —
// panels dispatch intents; a sibling overlay to the canvas, so it never touches render.

export interface Shell {
  readonly root: HTMLElement;
  /** The element a panel mounts into. Throws on an unknown panel name. */
  panelHost(name: string): HTMLElement;
  dispose(): void;
}

export interface ShellOptions {
  readonly parent: HTMLElement;
  readonly dockedSide: "left" | "right";
  readonly panels: readonly string[];
  readonly uiStore: UiStore;
}

export function createShell(opts: ShellOptions): Shell {
  const doc = opts.parent.ownerDocument;
  const root = doc.createElement("div");
  root.className = "webpic-shell";
  root.dataset.side = opts.dockedSide;

  const hosts = new Map<string, HTMLElement>();
  for (const name of opts.panels) {
    const host = doc.createElement("div");
    host.className = "webpic-panel";
    host.dataset.panel = name;
    root.appendChild(host);
    hosts.set(name, host);
  }
  opts.parent.appendChild(root);

  const applyVisible = (visible: boolean): void => {
    root.hidden = !visible;
  };
  const applyPanels = (panels: Readonly<Record<string, boolean>>): void => {
    for (const [name, host] of hosts) host.hidden = !(panels[name] ?? true);
  };

  const initial = opts.uiStore.getState();
  applyVisible(initial.isUiVisible);
  applyPanels(initial.panels);

  const unsubVisible = opts.uiStore.subscribe((s) => s.isUiVisible, applyVisible);
  const unsubPanels = opts.uiStore.subscribe((s) => s.panels, applyPanels);

  return {
    root,
    panelHost(name) {
      const host = hosts.get(name);
      if (host === undefined) throw new Error(`createShell: unknown panel "${name}"`);
      return host;
    },
    dispose() {
      unsubVisible();
      unsubPanels();
      root.remove();
    },
  };
}
