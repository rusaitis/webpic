import { type SimulationStore, selectActiveLayer } from "@store";
import { createPane, type Disposer } from "../controls/index.ts";

// The Developer panel — the docked right-shell home for features under development that aren't yet
// in the main UI. Today it carries the volume-only Phong shading toggle (peeled off the colormap
// panel when the color mapping moved to the floating colorbar). More in-development controls slot in
// here until they earn a permanent surface — Phong itself migrates to a per-layer settings component
// when the Layers UI lands.

export function installDevPanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Developer" });
  const folder = pane.addFolder({ title: "Shading" });

  // Phong is volume-only (a slice has no depth gradient to light); the checkbox disables otherwise.
  const shadingControl = folder.addCheckbox({
    label: "Phong",
    value: false,
    onChange: (on) => {
      const layer = selectActiveLayer(store.getState());
      if (layer?.kind === "volume") store.getState().setLayerShading(layer.id, on);
    },
  });
  const syncShading = (): void => {
    const layer = selectActiveLayer(store.getState());
    const isVolume = layer?.kind === "volume";
    shadingControl.set(isVolume ? layer.shaded : false);
    shadingControl.setDisabled(!isVolume);
  };

  syncShading();

  const unsubSelected = store.subscribe((s) => s.selectedLayerId, syncShading);
  const unsubLayers = store.subscribe((s) => {
    const layer = selectActiveLayer(s);
    return layer?.kind === "volume" ? layer.shaded : null; // reflect an external shaded flip
  }, syncShading);

  return () => {
    unsubLayers();
    unsubSelected();
    shadingControl.dispose();
    pane.dispose();
  };
}
