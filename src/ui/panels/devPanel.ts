import { type SimulationStore, selectActiveLayer } from "@store";
import { createPane, type Disposer } from "../controls/index.ts";
import { createSubscriptions } from "../subscriptions.ts";

// The Developer tool's contents — the volume-only Phong shading toggle (peeled off the colormap panel
// when color mapping moved to the floating colorbar). Built into a host (the floating Developer
// window's body, which owns the title) as a catch-all for in-development controls until they earn a
// permanent surface — Phong migrates to a per-layer settings component when the Layers UI lands.

export function installDevPanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host });
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

  const subs = createSubscriptions();
  subs.on(store, (s) => s.selectedLayerId, syncShading);
  subs.on(
    store,
    (s) => {
      const layer = selectActiveLayer(s);
      return layer?.kind === "volume" ? layer.shaded : null; // reflect an external shaded flip
    },
    syncShading,
  );

  return () => {
    subs.dispose();
    pane.dispose(); // cascades to the shading checkbox
  };
}
