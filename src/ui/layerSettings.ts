import { clamp } from "@schema/math.ts";
import type { FieldName } from "@schema/types.ts";
import {
  LAYER_KINDS,
  type Layer,
  type SimulationStore,
  type SliceAxis,
  selectActiveLayer,
  type TraceNotice,
  type UiStore,
} from "@store";
import { installChromeVisibility } from "./chromeVisibility.ts";
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
import { ICON_CARET, ICON_CARET_UP } from "./icons.ts";
import { createSubscriptions } from "./subscriptions.ts";

// The per-layer settings window (DESIGN §"Layers & navigation"): ONE component, opened from two entry
// points (the Layers-panel gear, the rail's "Add new") so a layer is never configured in two places.
// It always reflects the *selected* layer — both entry points select then open — which lets the
// colormap/scale/window section reuse installColormapControls verbatim (it is already selected-layer-
// bound). The rest is the field/opacity/visibility/draw-order/remove form plus kind-specific controls
// (volume: Phong; slice: axis + position; field lines: seed count + click-to-place). ui → store only.

const SLICE_AXES: ReadonlyArray<{ value: SliceAxis; label: string }> = [
  { value: "x", label: "x" },
  { value: "y", label: "y" },
  { value: "z", label: "z" },
];

// Seed-rake bounds for the count slider (defaultSeedRake floors at 2). 32 keeps the CPU re-trace snappy.
const MIN_SEEDS = 2;
const MAX_SEEDS = 32;

// The slider's range is narrower than a placed rake may be, so the displayed count is the clamped
// one — the layer keeps its real seeds either way.
const seedCountFor = (layer: { readonly seeds: ReadonlyArray<unknown> }): number =>
  clamp(layer.seeds.length, MIN_SEEDS, MAX_SEEDS);

const PLACE_HINT = 'toggle "Place seeds", then click the volume';

// The field-lines status line: seeds asked for, lines drawn, the vector they followed, and why any
// seed was dropped. `notice` is undefined until the layer's first retrace lands.
function seedSummary(n: number, notice: TraceNotice | undefined): string {
  const seeds = `${n} seed${n === 1 ? "" : "s"}`;
  if (notice === undefined) return `${seeds} · ${PLACE_HINT}`;
  if (notice.error !== null) return `${seeds} · ${notice.error}`;
  const drawn =
    notice.traced === 0 ? "no lines" : `${notice.traced} line${notice.traced === 1 ? "" : "s"}`;
  const parts = [seeds, drawn];
  if (notice.fieldName !== null) parts.push(notice.fieldName);
  if (notice.nullSeeds > 0)
    parts.push(`${notice.nullSeeds} seed${notice.nullSeeds === 1 ? "" : "s"} at a field null`);
  if (notice.outsideSeeds > 0)
    parts.push(
      `${notice.outsideSeeds} seed${notice.outsideSeeds === 1 ? "" : "s"} outside the domain`,
    );
  if (notice.failedSeeds > 0)
    parts.push(`${notice.failedSeeds} seed${notice.failedSeeds === 1 ? "" : "s"} would not trace`);
  if (notice.traced === n) parts.push(PLACE_HINT);
  return parts.join(" · ");
}

// Seeds skipped or nothing drawn — amber, so an empty layer never reads as an empty scene.
function noticeKind(notice: TraceNotice | undefined): string | null {
  if (notice === undefined) return null;
  return notice.error !== null || notice.traced < notice.requested ? "warn" : null;
}

function applySeedNote(
  note: NoteHandle | null,
  layer: Layer,
  notice: TraceNotice | undefined,
): void {
  if (note === null || layer.kind !== "fieldlines") return;
  note.element.textContent = seedSummary(layer.seeds.length, notice);
  const kind = noticeKind(notice);
  if (kind === null) note.element.removeAttribute("data-kind");
  else note.element.dataset.kind = kind;
}

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
    getState().availableFields.map((name) => ({ value: name, label: name }));

  const dispose = (): void => {
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
    const { layers } = getState();
    const index = layers.findIndex((layer) => layer.id === built?.layerId);
    upBtn.disabled = index <= 0;
    downBtn.disabled = index < 0 || index >= layers.length - 1;
  };

  const buildActions = (layer: Layer): void => {
    const up = makeIconButton(doc, "webpic-layerset_move", ICON_CARET_UP, { ariaLabel: "Move up" });
    up.addEventListener("click", () => {
      const index = getState().layers.findIndex((l) => l.id === layer.id);
      if (index > 0) getState().reorderLayer(layer.id, index - 1);
    });
    const down = makeIconButton(doc, "webpic-layerset_move", ICON_CARET, {
      ariaLabel: "Move down",
    });
    down.addEventListener("click", () => {
      const { layers } = getState();
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
    dispose();
    const layer = selectActiveLayer(getState());
    if (layer === null) {
      built = null;
      win.setTitle("Layer");
      const empty = makeEl(doc, "div", "webpic-layerset_empty");
      empty.textContent = "No layer selected.";
      paneHost.append(empty);
      return;
    }
    built = { layerId: layer.id, kind: layer.kind };
    win.setTitle(`${LAYER_KINDS[layer.kind].label} · ${layer.field}`);

    pane = createPane({ parent: paneHost });
    const folder = pane.addFolder({ title: LAYER_KINDS[layer.kind].label });

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

    switch (layer.kind) {
      case "volume": {
        shadedControl = folder.addCheckbox({
          label: "Phong shading",
          value: layer.shaded,
          onChange: (value) => getState().setLayerShading(layer.id, value),
        });
        break;
      }
      case "slice": {
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
        break;
      }
      case "fieldlines": {
        seedCountControl = folder.addSlider({
          label: "Seed count",
          value: seedCountFor(layer),
          min: MIN_SEEDS,
          max: MAX_SEEDS,
          step: 1,
          onChange: (count) => getState().setFieldlineSeedCount(layer.id, Math.round(count)),
        });
        placeControl = folder.addCheckbox({
          label: "Place seeds",
          value: getState().seedPlacementLayerId === layer.id,
          onChange: (on) => getState().setSeedPlacement(on ? layer.id : null),
        });
        seedNote = folder.addNote("");
        applySeedNote(seedNote, layer, getState().traceNotices[layer.id]);
        break;
      }
    }

    buildActions(layer);
  };

  // Reflect value edits without a rebuild (opacity/visible/position/axis/seed-count, reorder enablement).
  // A selection / kind change (or the layer vanishing) falls through to a full rebuild.
  const sync = (): void => {
    const layer = selectActiveLayer(getState());
    if (
      layer === null ||
      built === null ||
      layer.id !== built.layerId ||
      layer.kind !== built.kind
    ) {
      rebuild();
      return;
    }
    win.setTitle(`${LAYER_KINDS[layer.kind].label} · ${layer.field}`);
    fieldControl?.set(layer.field);
    opacityControl?.set(layer.opacity);
    visibleControl?.set(layer.visible);
    switch (layer.kind) {
      case "volume":
        shadedControl?.set(layer.shaded);
        break;
      case "slice":
        axisControl?.set(layer.axis);
        positionControl?.set(layer.position);
        break;
      case "fieldlines":
        seedCountControl?.set(seedCountFor(layer));
        placeControl?.set(getState().seedPlacementLayerId === layer.id);
        applySeedNote(seedNote, layer, getState().traceNotices[layer.id]);
        break;
    }
    updateReorder();
  };

  const syncPlacement = (): void => {
    const layer = selectActiveLayer(getState());
    if (layer?.kind === "fieldlines") {
      placeControl?.set(getState().seedPlacementLayerId === layer.id);
    }
  };

  rebuild();

  const subscriptions = createSubscriptions();
  const applyVisible = installChromeVisibility(
    subscriptions,
    uiStore,
    (isVisible) => {
      if (isVisible) win.show();
      else win.hide();
    },
    () => uiStore.getState().isLayerSettingsOpen,
  );
  subscriptions.on(store, (s) => s.selectedLayerId, rebuild);
  subscriptions.on(store, (s) => s.availableFields, rebuild); // new dataset → new field options
  subscriptions.on(store, (s) => s.layers, sync);
  subscriptions.on(store, (s) => s.seedPlacementLayerId, syncPlacement);
  subscriptions.on(store, (s) => s.traceNotices, sync); // the seed note reports what the last retrace did
  subscriptions.on(uiStore, (s) => s.isLayerSettingsOpen, applyVisible);

  return () => {
    subscriptions.dispose();
    dispose();
    disposeColormap();
    win.dispose();
  };
}
