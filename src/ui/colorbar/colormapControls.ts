import {
  COLOR_SCALES,
  COLORMAP_IDS,
  type ColormapBinding,
  type ColormapId,
  type ColorScale,
  DEFAULT_COLORMAP,
} from "@schema/colormap.ts";
import type { DataRange, Layer, SimulationStore } from "@store";
import {
  type ControlHandle,
  createPane,
  type Disposer,
  intervalToWindow,
  type RangeValue,
  type SelectHandle,
  windowToInterval,
} from "../controls/index.ts";
import { formatValue } from "./colorbarGradient.ts";

// The colormap controls — colormap / value→color scale / window-level — for the *selected layer's*
// ColormapBinding. Lifted from the old docked colormap panel; now mounted into the floating
// colorbar's settings popover. Each control dispatches a setBinding* intent and mirrors external
// edits in place; the app's layerSync resolves the changed binding to the layers that reference it.
// Window is an [lo, hi] interval; the binding stores the canonical {center, width}.

// Narrowest window as a fraction of the track — keeps the in-shader width > 0 (parallels render's
// MIN_WIDTH in normalization.ts).
const MIN_WINDOW_FRACTION = 1 / 1000;

const colormapOptions = COLORMAP_IDS.map((id) => ({ value: id, label: id }));
const scaleOptions = COLOR_SCALES.map((scale) => ({ value: scale, label: scale }));

// log needs a positive track minimum (makeScale throws on min ≤ 0): the data minimum when positive,
// else a small fraction of the maximum — a v0.1 stand-in for magviz's logFloor.
function logTrackMin(bounds: DataRange): number {
  return Math.max(bounds.min, bounds.max > 0 ? bounds.max * 1e-6 : 1);
}

interface ActiveBinding {
  readonly id: string;
  readonly binding: ColormapBinding;
  readonly bounds: DataRange | null;
}

export function installColormapControls(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Colormap" });
  const folder = pane.addFolder({ title: "Display range" });

  let colormapControl: SelectHandle<ColormapId> | null = null;
  let scaleControl: SelectHandle<ColorScale> | null = null;
  let windowControl: ControlHandle<RangeValue> | null = null;
  let currentBindingId: string | null = null;
  let currentScale: ColorScale | null = null;

  const activeLayer = (): Layer | null => {
    const { selectedLayerId, layers } = store.getState();
    if (selectedLayerId === null) return null;
    return layers.find((layer) => layer.id === selectedLayerId) ?? null;
  };

  const active = (): ActiveBinding | null => {
    const { colormapBindings, dataRange } = store.getState();
    const bindingId = activeLayer()?.colormapBindingId ?? null;
    if (bindingId === null) return null;
    const binding = colormapBindings[bindingId];
    if (binding === undefined) return null;
    return { id: bindingId, binding, bounds: dataRange };
  };

  const dispatchColormap = (colormap: ColormapId): void => {
    const a = active();
    if (a !== null) store.getState().setBindingColormap(a.id, colormap);
  };
  const dispatchScale = (scale: ColorScale): void => {
    const a = active();
    if (a !== null) store.getState().setBindingScale(a.id, scale);
  };
  const dispatchWindow = (v: RangeValue): void => {
    if (typeof v === "number") return; // interval mode always emits a pair
    const a = active();
    if (a === null) return;
    const { center, width } = intervalToWindow(v[0], v[1]);
    store.getState().setBindingWindow(a.id, center, width);
  };

  // The window control's track scale + bounds are baked at construction, so a scale or extent change
  // means a fresh control rather than a mutation. Disabled until the active field's range is known.
  const makeWindow = (a: ActiveBinding | null): void => {
    windowControl?.dispose();
    const bounds = a?.bounds ?? { min: 0, max: 1 };
    const scale = a?.binding.scale ?? "linear";
    const trackMin = scale === "log" ? logTrackMin(bounds) : bounds.min;
    const win = a?.binding.window ?? {
      center: (bounds.min + bounds.max) / 2,
      width: bounds.max - bounds.min,
    };
    const [rawLo, rawHi] = windowToInterval(win);
    const lo = Math.max(rawLo, trackMin); // clamp into the (possibly log-floored) track
    const hi = Math.max(rawHi, lo);
    windowControl = folder.addRangeControl({
      label: "Window",
      min: trackMin,
      max: bounds.max,
      range: [lo, hi],
      scale,
      format: formatValue,
      minGap: (bounds.max - trackMin) * MIN_WINDOW_FRACTION,
      onInput: dispatchWindow,
      onChange: dispatchWindow,
    });
    windowControl.setDisabled(a === null || a.bounds === null);
  };

  const rebuild = (): void => {
    colormapControl?.dispose();
    scaleControl?.dispose();
    const a = active();
    const disabled = a === null;
    currentBindingId = a?.id ?? null;
    currentScale = a?.binding.scale ?? "linear";
    colormapControl = folder.addSelect<ColormapId>({
      label: "Colormap",
      value: a?.binding.colormap ?? DEFAULT_COLORMAP,
      options: colormapOptions,
      onChange: dispatchColormap,
    });
    colormapControl.setDisabled(disabled);
    scaleControl = folder.addSelect<ColorScale>({
      label: "Scale",
      value: a?.binding.scale ?? "linear",
      options: scaleOptions,
      onChange: dispatchScale,
    });
    scaleControl.setDisabled(disabled);
    makeWindow(a);
  };

  // Reflect a binding edit without rebuilding (the drag hot path): mirror colormap + window in place;
  // a scale change re-bakes only the window control (its track mapping changed).
  const sync = (): void => {
    const a = active();
    if (a === null || a.id !== currentBindingId) {
      rebuild();
      return;
    }
    colormapControl?.set(a.binding.colormap);
    if (a.binding.scale !== currentScale) {
      currentScale = a.binding.scale;
      scaleControl?.set(a.binding.scale);
      makeWindow(a);
      return;
    }
    windowControl?.set(windowToInterval(a.binding.window));
  };

  rebuild();

  const unsubSelected = store.subscribe((s) => s.selectedLayerId, rebuild);
  const unsubRange = store.subscribe((s) => s.dataRange, rebuild); // new extent → re-bake the track
  const unsubBindings = store.subscribe((s) => {
    const layer =
      s.selectedLayerId === null ? undefined : s.layers.find((l) => l.id === s.selectedLayerId);
    const bindingId = layer?.colormapBindingId ?? null;
    return bindingId === null ? null : (s.colormapBindings[bindingId] ?? null);
  }, sync);

  return () => {
    unsubBindings();
    unsubRange();
    unsubSelected();
    windowControl?.dispose();
    scaleControl?.dispose();
    colormapControl?.dispose();
    pane.dispose();
  };
}
