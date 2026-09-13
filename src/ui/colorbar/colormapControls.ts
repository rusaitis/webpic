import {
  COLOR_SCALES,
  COLORMAP_IDS,
  type ColormapBinding,
  type ColormapId,
  type ColorScale,
  DEFAULT_COLORMAP,
  logWindowFloor,
} from "@schema/colormap.ts";
import {
  type DataRange,
  type SimulationStore,
  selectActiveBinding,
  selectActiveLayer,
  selectDataRange,
} from "@store";
import {
  type ControlHandle,
  createPane,
  type Disposer,
  intervalToWindow,
  type RangeValue,
  type SelectHandle,
  windowToInterval,
} from "../controls/index.ts";
import { createSubscriptions } from "../subscriptions.ts";
import { formatValue, paintGradient } from "./colorbarGradient.ts";

// The colormap controls — colormap / value→color scale / window-level — for the *selected layer's*
// ColormapBinding, mounted in the floating colorbar's settings popover. Each control dispatches a setBinding* intent and mirrors external
// edits in place; the app's layerBridge resolves the changed binding to the layers that reference it.
// Window is an [lo, hi] interval; the binding stores the canonical {center, width}.

// Narrowest window as a fraction of the track — keeps the in-shader width > 0 (parallels render's
// MIN_WIDTH in normalization.ts).
const MIN_WINDOW_FRACTION = 1 / 1000;

const colormapOptions = COLORMAP_IDS.map((id) => ({ value: id, label: id }));
const scaleOptions = COLOR_SCALES.map((scale) => ({ value: scale, label: scale }));

// log needs a positive track minimum (makeScale throws on min ≤ 0): the data minimum when positive,
// else the shared decades floor (@schema/colormap) the shader normalizes with — same constant on both
// sides, so the slider track spans exactly what is drawn.
function logTrackMin(dataRange: DataRange): number {
  return Math.max(dataRange.min, logWindowFloor(dataRange.max) || 1);
}

interface ActiveBinding {
  readonly id: string;
  readonly binding: ColormapBinding;
  readonly dataRange: DataRange | null;
}

export function installColormapControls(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Colormap" });
  const folder = pane.addFolder({ title: "Display range" });

  let colormapControl: SelectHandle<ColormapId> | null = null;
  let scaleControl: ControlHandle<ColorScale> | null = null;
  let windowControl: ControlHandle<RangeValue> | null = null;
  let currentBindingId: string | null = null;
  let currentScale: ColorScale | null = null;

  const active = (): ActiveBinding | null => {
    const state = store.getState();
    const bindingId = selectActiveLayer(state)?.colormapBindingId ?? null;
    if (bindingId === null) return null;
    const binding = state.colormapBindings[bindingId];
    if (binding === undefined) return null;
    return { id: bindingId, binding, dataRange: selectDataRange(state) };
  };

  const dispatchColormap = (colormap: ColormapId): void => {
    const activeBinding = active();
    if (activeBinding !== null) store.getState().setBindingColormap(activeBinding.id, colormap);
  };
  const dispatchScale = (scale: ColorScale): void => {
    const activeBinding = active();
    if (activeBinding !== null) store.getState().setBindingScale(activeBinding.id, scale);
  };
  const dispatchWindow = (v: RangeValue): void => {
    if (typeof v === "number") return; // interval mode always emits a pair
    const activeBinding = active();
    if (activeBinding === null) return;
    const { center, width } = intervalToWindow(v[0], v[1]);
    store.getState().setBindingWindow(activeBinding.id, center, width);
  };

  // The window control's track scale + range are baked at construction, so a scale or extent change
  // means a fresh control rather than a mutation. Disabled until the active field's range is known.
  const makeWindow = (activeBinding: ActiveBinding | null): void => {
    windowControl?.dispose();
    const dataRange = activeBinding?.dataRange ?? { min: 0, max: 1 };
    const scale = activeBinding?.binding.scale ?? "linear";
    const trackMin = scale === "log" ? logTrackMin(dataRange) : dataRange.min;
    const win = activeBinding?.binding.window ?? {
      center: (dataRange.min + dataRange.max) / 2,
      width: dataRange.max - dataRange.min,
    };
    const [rawLo, rawHi] = windowToInterval(win);
    const lo = Math.max(rawLo, trackMin); // clamp into the (possibly log-floored) track
    const hi = Math.max(rawHi, lo);
    windowControl = folder.addRangeControl({
      label: "Window",
      min: trackMin,
      max: dataRange.max,
      range: [lo, hi],
      scale,
      format: formatValue,
      minGap: (dataRange.max - trackMin) * MIN_WINDOW_FRACTION,
      onInput: dispatchWindow,
      onChange: dispatchWindow,
    });
    windowControl.setDisabled(activeBinding === null || activeBinding.dataRange === null);
  };

  const rebuild = (): void => {
    colormapControl?.dispose();
    scaleControl?.dispose();
    const activeBinding = active();
    const disabled = activeBinding === null;
    currentBindingId = activeBinding?.id ?? null;
    currentScale = activeBinding?.binding.scale ?? "linear";
    colormapControl = folder.addSwatchSelect<ColormapId>({
      label: "Colormap",
      value: activeBinding?.binding.colormap ?? DEFAULT_COLORMAP,
      options: colormapOptions,
      onChange: dispatchColormap,
      paintSwatch: (canvas, id) => paintGradient(canvas, id, true),
    });
    colormapControl.setDisabled(disabled);
    scaleControl = folder.addSegmented<ColorScale>({
      label: "Scale",
      value: activeBinding?.binding.scale ?? "linear",
      options: scaleOptions,
      onChange: dispatchScale,
    });
    scaleControl.setDisabled(disabled);
    makeWindow(activeBinding);
  };

  // Reflect a binding edit without rebuilding (the drag hot path): mirror colormap + window in place;
  // a scale change re-bakes only the window control (its track mapping changed).
  const sync = (): void => {
    const activeBinding = active();
    if (activeBinding === null || activeBinding.id !== currentBindingId) {
      rebuild();
      return;
    }
    colormapControl?.set(activeBinding.binding.colormap);
    if (activeBinding.binding.scale !== currentScale) {
      currentScale = activeBinding.binding.scale;
      scaleControl?.set(activeBinding.binding.scale);
      makeWindow(activeBinding);
      return;
    }
    windowControl?.set(windowToInterval(activeBinding.binding.window));
  };

  rebuild();

  const subscriptions = createSubscriptions();
  subscriptions.on(store, (s) => s.selectedLayerId, rebuild);
  subscriptions.on(store, selectDataRange, rebuild); // new extent → re-bake the track
  subscriptions.on(store, selectActiveBinding, sync);

  return () => {
    subscriptions.dispose();
    windowControl?.dispose();
    scaleControl?.dispose();
    colormapControl?.dispose();
    pane.dispose();
  };
}
