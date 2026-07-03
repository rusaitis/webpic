import type { FieldName } from "@schema/types.ts";
import {
  type Layer,
  type SimulationStore,
  type SliceAxis,
  selectActiveLayer,
  type UiStore,
} from "@store";
import { installColormapControls } from "./colorbar/colormapControls.ts";
import { makeEl, makeIconButton } from "./controls/dom.ts";
import {
  type ControlHandle,
  createPane,
  type Disposer,
  type NoteHandle,
  type Pane,
  type SelectHandle,
} from "./controls/index.ts";
import { createFloatingWindow } from "./floating/floatingWindow.ts";
import { ICON_CARET_DOWN, ICON_CARET_UP } from "./layerIcons.ts";

// The per-layer settings window (DESIGN §"Layers & navigation"): ONE component, opened from two entry
// points (the Layers-panel gear, the rail's "Add new") so a layer is never configured in two places.
// It always reflects the *selected* layer — both entry points select then open — which lets the
// colormap/scale/window section reuse installColormapControls verbatim (it is already selected-layer-
// bound). The rest is the field/opacity/visibility/draw-order/remove form plus kind-specific controls
// (volume: Phong; slice: axis + position; field lines: seed count + click-to-place). ui → store only.

const KIND_TITLE: Record<Layer["kind"], string> = {
  volume: "Volume",
  slice: "Slice",
  fieldlines: "Field lines",
  particles: "Particles",
};

const SLICE_AXES: ReadonlyArray<{ value: SliceAxis; label: string }> = [
  { value: "x", label: "x" },
  { value: "y", label: "y" },
  { value: "z", label: "z" },
];

// Seed-rake bounds for the count slider (defaultSeedRake floors at 2). 32 keeps the CPU re-trace snappy.
const MIN_SEEDS = 2;
const MAX_SEEDS = 32;

const seedSummary = (n: number): string =>
  `${n} seed${n === 1 ? "" : "s"} · toggle "Place seeds", then click the volume`;

export function installLayerSettings(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const getState = store.getState;

  const win = createFloatingWindow({
    parent,
    title: "Layer",
    width: 272,
    height: 360,
    // Open clear of the left tool rail + Layers overlay (its gear is an entry point) so neither clips
    // the window — not the default top-right, which collides with the Developer window.
    initial: { top: 64, left: 320 },
    onClose: () => {
      uiStore.getState().setLayerSettingsVisible(false);
      getState().setSeedPlacement(null); // don't leave the canvas in place-mode behind a closed window
    },
  });

  // Body: a rebuilt "Layer" pane + a rebuilt action row, then the reused (self-managing) colormap pane.
  const paneHost = makeEl(doc, "div", "webpic-layerset_pane");
  const actionRow = makeEl(doc, "div", "webpic-layerset_actions");
  win.body.append(paneHost, actionRow);
  const disposeColormap = installColormapControls(win.body, store);

  // The current build's identity (layer id + kind) and the control handles, held for in-place value
  // sync — a value change (opacity drag, eye toggle, position drag) reflects via set() without a rebuild;
  // only a selection / kind / option change rebuilds (mirrors colormapControls' rebuild vs sync split).
  let pane: Pane | null = null;
  let built: { readonly layerId: string; readonly kind: Layer["kind"] } | null = null;
  let fieldControl: SelectHandle<FieldName> | null = null;
  let opacityControl: ControlHandle<number> | null = null;
  let visibleControl: ControlHandle<boolean> | null = null;
  let axisControl: ControlHandle<SliceAxis> | null = null;
  let positionControl: ControlHandle<number> | null = null;
  let shadedControl: ControlHandle<boolean> | null = null;
  let seedCountControl: ControlHandle<number> | null = null;
  let placeControl: ControlHandle<boolean> | null = null;
  let seedNote: NoteHandle | null = null;
  let upBtn: HTMLButtonElement | null = null;
  let downBtn: HTMLButtonElement | null = null;

  const fieldOptions = (): ReadonlyArray<{ value: FieldName; label: FieldName }> =>
    store.getState().availableFields.map((name) => ({ value: name, label: name }));

  const teardown = (): void => {
    pane?.dispose();
    pane = null;
    fieldControl = null;
    opacityControl = null;
    visibleControl = null;
    axisControl = null;
    positionControl = null;
    shadedControl = null;
    seedCountControl = null;
    placeControl = null;
    seedNote = null;
    upBtn = null;
    downBtn = null;
    paneHost.replaceChildren();
    actionRow.replaceChildren();
  };

  const updateReorder = (): void => {
    if (built === null || upBtn === null || downBtn === null) return;
    const { layers } = store.getState();
    const index = layers.findIndex((layer) => layer.id === built?.layerId);
    upBtn.disabled = index <= 0;
    downBtn.disabled = index < 0 || index >= layers.length - 1;
  };

  const buildActions = (layer: Layer): void => {
    const up = makeIconButton(doc, "webpic-layerset_move", ICON_CARET_UP, { ariaLabel: "Move up" });
    up.addEventListener("click", () => {
      const index = store.getState().layers.findIndex((l) => l.id === layer.id);
      if (index > 0) getState().reorderLayer(layer.id, index - 1);
    });
    const down = makeIconButton(doc, "webpic-layerset_move", ICON_CARET_DOWN, {
      ariaLabel: "Move down",
    });
    down.addEventListener("click", () => {
      const { layers } = store.getState();
      const index = layers.findIndex((l) => l.id === layer.id);
      if (index >= 0 && index < layers.length - 1) getState().reorderLayer(layer.id, index + 1);
    });
    upBtn = up;
    downBtn = down;
    const spacer = makeEl(doc, "div", "webpic-layerset_spacer");
    actionRow.append(up, down, spacer);

    if (layer.kind === "fieldlines") {
      const clear = makeEl(doc, "button", "webpic-layerset_btn");
      clear.type = "button";
      clear.textContent = "Clear seeds";
      clear.addEventListener("click", () => getState().setFieldlineSeeds(layer.id, []));
      actionRow.append(clear);
    }
    const remove = makeEl(doc, "button", "webpic-layerset_btn is-danger");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => getState().removeLayer(layer.id));
    actionRow.append(remove);
    updateReorder();
  };

  const rebuild = (): void => {
    teardown();
    const layer = selectActiveLayer(store.getState());
    if (layer === null) {
      built = null;
      win.setTitle("Layer");
      const empty = makeEl(doc, "div", "webpic-layerset_empty");
      empty.textContent = "No layer selected.";
      paneHost.append(empty);
      return;
    }
    built = { layerId: layer.id, kind: layer.kind };
    win.setTitle(`${KIND_TITLE[layer.kind]} · ${layer.field}`);

    pane = createPane({ parent: paneHost });
    const folder = pane.addFolder({ title: KIND_TITLE[layer.kind] });

    // The field control retargets the selected layer (= this layer); selectField repoints it + recomputes.
    fieldControl = folder.addSelect<FieldName>({
      label: "Field",
      value: layer.field,
      options: fieldOptions(),
      onChange: (name) => void getState().selectField(name),
    });
    opacityControl = folder.addSlider({
      label: "Opacity",
      value: layer.opacity,
      min: 0,
      max: 1,
      step: 0.01,
      onChange: (value) => getState().setLayerOpacity(layer.id, value),
    });
    visibleControl = folder.addCheckbox({
      label: "Visible",
      value: layer.visible,
      onChange: (value) => getState().setLayerVisible(layer.id, value),
    });

    if (layer.kind === "volume") {
      shadedControl = folder.addCheckbox({
        label: "Phong shading",
        value: layer.shaded,
        onChange: (value) => getState().setLayerShading(layer.id, value),
      });
    } else if (layer.kind === "slice") {
      axisControl = folder.addSegmented<SliceAxis>({
        label: "Axis",
        value: layer.axis,
        options: SLICE_AXES,
        onChange: (axis) => getState().setSliceAxis(layer.id, axis),
      });
      positionControl = folder.addSlider({
        label: "Position",
        value: layer.position,
        min: 0,
        max: 1,
        step: 0.005,
        onChange: (value) => getState().setSlicePosition(layer.id, value),
      });
    } else if (layer.kind === "fieldlines") {
      seedCountControl = folder.addSlider({
        label: "Seed count",
        value: Math.min(Math.max(layer.seeds.length, MIN_SEEDS), MAX_SEEDS),
        min: MIN_SEEDS,
        max: MAX_SEEDS,
        step: 1,
        onChange: (count) => getState().setFieldlineSeedCount(layer.id, Math.round(count)),
      });
      placeControl = folder.addCheckbox({
        label: "Place seeds",
        value: store.getState().seedPlacementLayerId === layer.id,
        onChange: (on) => getState().setSeedPlacement(on ? layer.id : null),
      });
      seedNote = folder.addNote(seedSummary(layer.seeds.length));
    } else {
      folder.addNote("Particles render in v0.2.");
    }

    buildActions(layer);
  };

  // Reflect value edits without a rebuild (opacity/visible/position/axis/seed-count, reorder enablement).
  // A selection / kind change (or the layer vanishing) falls through to a full rebuild.
  const sync = (): void => {
    const layer = selectActiveLayer(store.getState());
    if (
      layer === null ||
      built === null ||
      layer.id !== built.layerId ||
      layer.kind !== built.kind
    ) {
      rebuild();
      return;
    }
    win.setTitle(`${KIND_TITLE[layer.kind]} · ${layer.field}`);
    fieldControl?.set(layer.field);
    opacityControl?.set(layer.opacity);
    visibleControl?.set(layer.visible);
    if (layer.kind === "volume") shadedControl?.set(layer.shaded);
    else if (layer.kind === "slice") {
      axisControl?.set(layer.axis);
      positionControl?.set(layer.position);
    } else if (layer.kind === "fieldlines") {
      seedCountControl?.set(Math.min(Math.max(layer.seeds.length, MIN_SEEDS), MAX_SEEDS));
      placeControl?.set(store.getState().seedPlacementLayerId === layer.id);
      if (seedNote !== null) seedNote.element.textContent = seedSummary(layer.seeds.length);
    }
    updateReorder();
  };

  const syncPlacement = (): void => {
    const layer = selectActiveLayer(store.getState());
    if (layer?.kind === "fieldlines") {
      placeControl?.set(store.getState().seedPlacementLayerId === layer.id);
    }
  };

  const applyVisible = (): void => {
    const ui = uiStore.getState();
    if (ui.isUiVisible && ui.isLayerSettingsOpen) win.show();
    else win.hide();
  };

  rebuild();
  applyVisible();

  const unsubs = [
    store.subscribe((s) => s.selectedLayerId, rebuild),
    store.subscribe((s) => s.availableFields, rebuild), // new dataset → new field options
    store.subscribe((s) => s.layers, sync),
    store.subscribe((s) => s.seedPlacementLayerId, syncPlacement),
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
    uiStore.subscribe((s) => s.isLayerSettingsOpen, applyVisible),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
    teardown();
    disposeColormap();
    win.dispose();
  };
}
