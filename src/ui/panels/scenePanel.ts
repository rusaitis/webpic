import {
  GRID_DIVISIONS_MAX,
  GRID_DIVISIONS_MIN,
  type GridPlane,
  type SimulationStore,
} from "@store";
import { type ControlHandle, createPane, type Disposer } from "../controls/index.ts";

// The Scene panel: toggles for the in-scene axes + grid overlay (per-plane), tick labels, the corner
// gnomon, the grid density, and a Camera folder (fit-to-data). Dispatches store intents only
// (ui → store; never render) — the app's sceneSync forwards the render-bound flags to the worker,
// cameraChrome consumes showGnomon, and pointerCamera resolves the fly intents.

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

  const picker: ControlHandle<boolean> = folder.addCheckbox({
    label: "Point marker",
    value: initial.showPicker,
    onChange: (on) => store.getState().setOverlayShowPicker(on),
  });

  const density: ControlHandle<number> = folder.addSlider({
    label: "Density",
    value: initial.gridDivisions,
    min: GRID_DIVISIONS_MIN,
    max: GRID_DIVISIONS_MAX,
    step: 1,
    onChange: (n) => store.getState().setGridDivisions(n),
  });

  const cameraFolder = pane.addFolder({ title: "Camera" });
  const fit = cameraFolder.addButton({
    label: "Fit view (Z)",
    onClick: () => store.getState().requestCameraFly({ kind: "fit" }),
  });
  const ortho: ControlHandle<boolean> = cameraFolder.addCheckbox({
    label: "Orthographic (O)",
    value: store.getState().projection === "orthographic",
    onChange: (on) => store.getState().setProjection(on ? "orthographic" : "perspective"),
  });
  const unsubscribeProjection = store.subscribe(
    (s) => s.projection,
    (next) => ortho.set(next === "orthographic"),
  );

  // Reflect external changes (set()-in never re-fires onChange). Per-leaf selectors so a change to
  // one overlay field updates only its control — a Density drag no longer re-asserts every checkbox
  // each frame, it just moves the slider.
  const overlayUnsubs: Disposer[] = [
    store.subscribe(
      (s) => s.overlay.showGrid,
      (on) => grid.set(on),
    ),
    store.subscribe(
      (s) => s.overlay.showAxes,
      (on) => axes.set(on),
    ),
    store.subscribe(
      (s) => s.overlay.showLabels,
      (on) => labels.set(on),
    ),
    store.subscribe(
      (s) => s.overlay.showGnomon,
      (on) => gnomon.set(on),
    ),
    store.subscribe(
      (s) => s.overlay.showPicker,
      (on) => picker.set(on),
    ),
    store.subscribe(
      (s) => s.overlay.gridDivisions,
      (n) => density.set(n),
    ),
    ...planes.map(({ plane, handle }) =>
      store.subscribe(
        (s) => s.overlay.planes[plane],
        (on) => handle.set(on),
      ),
    ),
  ];

  return () => {
    for (const unsub of overlayUnsubs) unsub();
    unsubscribeProjection();
    ortho.dispose();
    fit.dispose();
    density.dispose();
    picker.dispose();
    gnomon.dispose();
    labels.dispose();
    axes.dispose();
    for (const { handle } of planes) handle.dispose();
    grid.dispose();
    pane.dispose();
  };
}
