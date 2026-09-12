import {
  GRID_DIVISIONS_MAX,
  GRID_DIVISIONS_MIN,
  GRID_PLANES,
  type GridPlane,
  type SimulationStore,
} from "@store";
import { type ControlHandle, createPane, type Disposer } from "../controls/index.ts";
import { createSubscriptions } from "../subscriptions.ts";

// The Scene panel: toggles for the in-scene axes + grid overlay (per-plane), tick labels, and the
// grid density — the reference-frame chrome. Dispatches store intents only (ui → store; never render)
// — the app's sceneBridge forwards these flags to the worker. The corner gnomon (bottom rail, camera
// orientation) and the point marker (left tool rail, a value probe) own their own surfaces, not this
// panel. Camera controls (fit, projection) live in the bottom rail + keyboard, not here.

const PLANE_LABELS: Readonly<Record<GridPlane, string>> = {
  xy: "XY plane (equator)",
  yz: "YZ plane",
  xz: "XZ plane",
};

export function installScenePanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Scene" });
  const folder = pane.addFolder({ title: "Axes & grid" });
  const initial = store.getState().overlay;

  const grid: ControlHandle<boolean> = folder.addCheckbox({
    label: "Grid",
    value: initial.showGrid,
    onChange: (on) => store.getState().setOverlayShowGrid(on),
  });

  const planes = GRID_PLANES.map((plane) => ({
    plane,
    handle: folder.addCheckbox({
      label: PLANE_LABELS[plane],
      value: initial.planes[plane],
      onChange: (on) => store.getState().setOverlayPlane(plane, on),
    }),
  }));

  const axes: ControlHandle<boolean> = folder.addCheckbox({
    label: "Axes",
    value: initial.showAxes,
    onChange: (on) => store.getState().setOverlayShowAxes(on),
  });

  const labels: ControlHandle<boolean> = folder.addCheckbox({
    label: "Labels",
    value: initial.showLabels,
    onChange: (on) => store.getState().setOverlayShowLabels(on),
  });

  const density: ControlHandle<number> = folder.addSlider({
    label: "Density",
    value: initial.gridDivisions,
    min: GRID_DIVISIONS_MIN,
    max: GRID_DIVISIONS_MAX,
    step: 1,
    onChange: (n) => store.getState().setGridDivisions(n),
  });

  // Reflect external changes (set()-in never re-fires onChange). Per-leaf selectors so a change to
  // one overlay field updates only its control — a Density drag does not re-assert every checkbox
  // each frame, it just moves the slider.
  const subscriptions = createSubscriptions();
  subscriptions.on(
    store,
    (s) => s.overlay.showGrid,
    (on) => grid.set(on),
  );
  subscriptions.on(
    store,
    (s) => s.overlay.showAxes,
    (on) => axes.set(on),
  );
  subscriptions.on(
    store,
    (s) => s.overlay.showLabels,
    (on) => labels.set(on),
  );
  subscriptions.on(
    store,
    (s) => s.overlay.gridDivisions,
    (n) => density.set(n),
  );
  for (const { plane, handle } of planes) {
    subscriptions.on(
      store,
      (s) => s.overlay.planes[plane],
      (on) => handle.set(on),
    );
  }

  return () => {
    subscriptions.dispose();
    pane.dispose(); // disposes every control the folder tracked — no per-handle teardown needed
  };
}
