import type { SimulationStore } from "@store";
import type { Disposer } from "../controls/index.ts";
import { installDiagnosticsPanel } from "./diagnosticsPanel.ts";
import { installFieldPanel } from "./fieldPanel.ts";
import { installPlaceholderPanel } from "./placeholderPanel.ts";

// Panel name → installer for the docked shell. Adding a panel is one entry here; an unknown name
// (e.g. a theme's default-panels) falls back to a placeholder so the shell layout stays honest.
// Deliberately absent: `colormap`/`layers` live in ui/colorbar/ (not docked), `dataset`/`time` in
// the top bar, `scene` is mounted directly by the side rail — none route through mountPanel.

export type PanelInstaller = (host: HTMLElement, store: SimulationStore) => Disposer;

export const PANEL_REGISTRY: Readonly<Record<string, PanelInstaller>> = {
  field: installFieldPanel,
  diagnostics: installDiagnosticsPanel,
};

export function mountPanel(name: string, host: HTMLElement, store: SimulationStore): Disposer {
  // noUncheckedIndexedAccess → installer is `PanelInstaller | undefined`.
  const install = PANEL_REGISTRY[name];
  return install ? install(host, store) : installPlaceholderPanel(host, name, "Coming soon");
}
