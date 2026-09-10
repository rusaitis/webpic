import type { UiStore } from "@store";
import { createSubscriptions } from "../subscriptions.ts";

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

  const subs = createSubscriptions();
  subs.on(opts.uiStore, (s) => s.isUiVisible, applyVisible, { fireNow: true });
  subs.on(opts.uiStore, (s) => s.panels, applyPanels, { fireNow: true });

  return {
    root,
    panelHost(name) {
      const host = hosts.get(name);
      if (host === undefined) throw new Error(`createShell: unknown panel "${name}"`);
      return host;
    },
    dispose() {
      subs.dispose();
      root.remove();
    },
  };
}
