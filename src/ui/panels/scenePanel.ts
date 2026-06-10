import {
  GRID_DIVISIONS_MAX,
  GRID_DIVISIONS_MIN,
  type GridPlane,
  type SimulationStore,
} from "@store";
import { type ControlHandle, createPane, type Disposer } from "../controls/index.ts";

// The Scene panel: toggles for the in-scene axes + grid overlay (per-plane), tick labels, the corner
// gnomon, and the grid density. Dispatches store intents only (ui → store; never render) — the app's
// sceneSync forwards the render-bound flags to the worker, and cameraChrome consumes showGnomon.

const PLANE_LABELS: Readonly<Record<GridPlane, string>> = {
  xy: "XY plane (equator)",
  yz: "YZ plane",
  xz: "XZ plane",
};
const PLANE_ORDER: readonly GridPlane[] = ["xy", "yz", "xz"];

export function installScenePanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Scene" });
  const folder = pane.addFolder({ title: "Axes & grid" });
  const initial = store.getState().overlay;

  const grid: ControlHandle<boolean> = folder.addCheckbox({
    label: "Grid",
    value: initial.showGrid,
    onChange: (on) => store.getState().setOverlayShowGrid(on),
  });

  const planes = PLANE_ORDER.map((plane) => ({
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

  const gnomon: ControlHandle<boolean> = folder.addCheckbox({
    label: "Corner gnomon",
    value: initial.showGnomon,
    onChange: (on) => store.getState().setOverlayShowGnomon(on),
  });

  const density: ControlHandle<number> = folder.addSlider({
    label: "Density",
    value: initial.gridDivisions,
    min: GRID_DIVISIONS_MIN,
    max: GRID_DIVISIONS_MAX,
    step: 1,
    onChange: (n) => store.getState().setGridDivisions(n),
  });

  // Reflect external changes (set()-in never re-fires onChange); one overlay selector, re-assert all.
  const unsubscribe = store.subscribe(
    (s) => s.overlay,
    (next) => {
      grid.set(next.showGrid);
      for (const { plane, handle } of planes) handle.set(next.planes[plane]);
      axes.set(next.showAxes);
      labels.set(next.showLabels);
      gnomon.set(next.showGnomon);
      density.set(next.gridDivisions);
    },
  );

  return () => {
    unsubscribe();
    density.dispose();
    gnomon.dispose();
    labels.dispose();
    axes.dispose();
    for (const { handle } of planes) handle.dispose();
    grid.dispose();
    pane.dispose();
  };
}
