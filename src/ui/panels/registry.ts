import type { SimulationStore } from "@store";
import type { Disposer } from "../controls/index.ts";
import { installFieldPanel } from "./fieldPanel.ts";
import { installPlaceholderPanel } from "./placeholderPanel.ts";

// Panel name → installer for the docked shell. Adding a panel is one entry here; an unknown name
// (e.g. a theme's default-panels) falls back to a placeholder so the shell layout stays honest.

export type PanelInstaller = (host: HTMLElement, store: SimulationStore) => Disposer;

export const PANEL_REGISTRY: Readonly<Record<string, PanelInstaller>> = {
  field: installFieldPanel,
};

// Panels a theme may still name that another surface owns — the instance-first UI moved most of the
// docked shell into floating chrome, but theme schema v1 `default-panels` predates that. Docking
// these anyway renders the surface twice (a second colorbar; a second Diagnostics pane that makes a
// bare `.webpic-pane` locator ambiguous under Playwright strict mode). They are relocated, not
// missing, so the shell drops them rather than placeholdering. Drop entries as the schema bumps.
export const SERVED_ELSEWHERE: ReadonlySet<string> = new Set([
  "colormap", // ui/colorbar/ — colormap controls live in the colorbar popover
  "layers", // ui/colorbar/ — the instance-first layer list
  "diagnostics", // ui/panels/devWindow.ts — the floating Developer window
  "dataset", // top bar
  "time", // top bar
  "scene", // left tool rail (installScenePanel, mounted directly — not via mountPanel)
]);

/** A theme-requested panel the docked shell should actually mount. */
export function isDockable(name: string): boolean {
  return !SERVED_ELSEWHERE.has(name);
}

/** Registered here, or knowingly owned by another surface — anything else is theme drift. */
export function isKnownPanel(name: string): boolean {
  return Object.hasOwn(PANEL_REGISTRY, name) || SERVED_ELSEWHERE.has(name);
}

export function mountPanel(name: string, host: HTMLElement, store: SimulationStore): Disposer {
  // noUncheckedIndexedAccess → installer is `PanelInstaller | undefined`.
  const install = PANEL_REGISTRY[name];
  return install ? install(host, store) : installPlaceholderPanel(host, name, "Coming soon");
}
