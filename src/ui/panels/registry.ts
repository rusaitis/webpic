import type { SimulationStore } from "@store";
import type { Disposer } from "../controls/index.ts";
import { installDatasetPanel } from "./datasetPanel.ts";
import { installDevPanel } from "./devPanel.ts";
import { installDiagnosticsPanel } from "./diagnosticsPanel.ts";
import { installFieldPanel } from "./fieldPanel.ts";
import { installPlaceholderPanel } from "./placeholderPanel.ts";
import { installScenePanel } from "./scenePanel.ts";
import { installTimePanel } from "./timePanel.ts";

// Panel name → installer. Adding a panel is one entry here; an unknown name (e.g. a theme's
// custom panel list) falls back to a placeholder so the shell layout stays honest.

export type PanelInstaller = (host: HTMLElement, store: SimulationStore) => Disposer;

export const PANEL_REGISTRY: Readonly<Record<string, PanelInstaller>> = {
  dataset: installDatasetPanel,
  field: installFieldPanel,
  time: installTimePanel,
  dev: installDevPanel,
  scene: installScenePanel,
  diagnostics: installDiagnosticsPanel,
};

export function mountPanel(name: string, host: HTMLElement, store: SimulationStore): Disposer {
  // noUncheckedIndexedAccess → installer is `PanelInstaller | undefined`.
  const install = PANEL_REGISTRY[name];
  return install ? install(host, store) : installPlaceholderPanel(host, name, "Coming soon");
}
