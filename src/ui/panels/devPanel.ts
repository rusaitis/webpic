import type { Layer, SimulationStore } from "@store";
import { createPane, type Disposer } from "../controls/index.ts";

// The Developer panel — the docked right-shell home for features under development that aren't yet
// in the main UI. Today it carries the volume-only Phong shading toggle (peeled off the colormap
// panel when the color mapping moved to the floating colorbar). More in-development controls slot in
// here until they earn a permanent surface — Phong itself migrates to a per-layer settings component
// when the Layers UI lands.

export function installDevPanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Developer" });
  const folder = pane.addFolder({ title: "Shading" });

  const activeLayer = (): Layer | null => {
    const { selectedLayerId, layers } = store.getState();
    if (selectedLayerId === null) return null;
    return layers.find((layer) => layer.id === selectedLayerId) ?? null;
  };

  // Phong is volume-only (a slice has no depth gradient to light); the checkbox disables otherwise.
  const shadingControl = folder.addCheckbox({
    label: "Phong",
    value: false,
    onChange: (on) => {
      const layer = activeLayer();
      if (layer?.kind === "volume") store.getState().setLayerShading(layer.id, on);
    },
  });
  const syncShading = (): void => {
    const layer = activeLayer();
    const isVolume = layer?.kind === "volume";
    shadingControl.set(isVolume ? layer.shaded : false);
    shadingControl.setDisabled(!isVolume);
  };

  syncShading();

  const unsubSelected = store.subscribe((s) => s.selectedLayerId, syncShading);
  const unsubLayers = store.subscribe((s) => {
    const layer =
      s.selectedLayerId === null ? undefined : s.layers.find((l) => l.id === s.selectedLayerId);
    return layer?.kind === "volume" ? layer.shaded : null; // reflect an external shaded flip
  }, syncShading);

  return () => {
    unsubLayers();
    unsubSelected();
    shadingControl.dispose();
    pane.dispose();
  };
}
