import type { SimulationStore } from "@store";
import {
  type ControlHandle,
  createPane,
  type Disposer,
  intervalToWindow,
  type RangeValue,
  windowToInterval,
} from "../controls/index.ts";

// The Layers panel's window/level control: a linear interval RangeControl over the active
// field's full extent. Emits an [lo, hi] interval; the store stores the canonical
// {center, width} (intervalToWindow at the seam). Colormap selection + the log/symlog scale
// pick land with M2.4's ColormapBinding.

// Compact readout: exponential for very small/large magnitudes, ~4 sig figs otherwise.
function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e4)) return v.toExponential(2);
  return Number(v.toPrecision(4)).toString();
}

export function installLayersPanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Layers" });
  const folder = pane.addFolder({ title: "Display range" });

  let control: ControlHandle<RangeValue> | null = null;

  const dispatchWindow = (v: RangeValue): void => {
    if (typeof v === "number") return; // interval mode always emits a pair
    const { center, width } = intervalToWindow(v[0], v[1]);
    store.getState().setWindowLevel(center, width);
  };

  // The scale + track bounds are baked at construction, so a new field's extent means a fresh
  // control rather than a mutation. Disabled until a field's data range is known.
  const build = (): void => {
    control?.dispose();
    const { dataRange, windowLevel } = store.getState();
    const bounds = dataRange ?? { min: 0, max: 1 };
    const range: [number, number] = windowLevel
      ? windowToInterval(windowLevel)
      : [bounds.min, bounds.max];
    control = folder.addRangeControl({
      label: "Window",
      min: bounds.min,
      max: bounds.max,
      range,
      scale: "linear",
      format: formatValue,
      onInput: dispatchWindow,
      onChange: dispatchWindow,
    });
    control.setDisabled(dataRange === null);
  };

  build();

  // External window changes (e.g. a programmatic reset) reflect in without re-firing callbacks.
  const unsubWindow = store.subscribe(
    (s) => s.windowLevel,
    (windowLevel) => {
      if (windowLevel) control?.set(windowToInterval(windowLevel));
    },
  );
  // A dataset switch or field change resizes the track — rebuild to rebake the bounds.
  const unsubRange = store.subscribe(
    (s) => s.dataRange,
    () => build(),
  );

  return () => {
    unsubRange();
    unsubWindow();
    control?.dispose();
    pane.dispose();
  };
}
