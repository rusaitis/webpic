import type { FieldName } from "@schema/types.ts";
import {
  LAYER_KINDS,
  type Layer,
  type SimulationStore,
  selectActiveLayer,
  type UiStore,
} from "@store";
import { installChromeVisibility } from "../chromeVisibility.ts";
import { installColormapControls } from "../colorbar/colormapControls.ts";
import { makeEl, makeIconButton } from "../controls/dom.ts";
import {
  type ControlHandle,
  createPane,
  type Disposer,
  type Pane,
  type SelectHandle,
} from "../controls/index.ts";
import { createFloatingWindow } from "../floating/floatingWindow.ts";
import { ICON_CARET, ICON_CARET_UP } from "../icons.ts";
import { createSubscriptions } from "../subscriptions.ts";
import { installKindControls } from "./kindControls.ts";

// The per-layer settings window (DESIGN §"Layers & navigation"): ONE component, opened from two entry
// points (the Layers-panel gear, the rail's "Add new") so a layer is never configured in two places.
// It always reflects the *selected* layer — both entry points select then open — which lets the
// colormap/scale/window section reuse installColormapControls verbatim (it is already selected-layer-
// bound). The rest is the field/opacity/visibility/draw-order/remove form plus kind-specific controls
// (volume: Phong; slice: axis + position; field lines: seed count + click-to-place). ui → store only.

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
  let reflectKind: ((layer: Layer) => void) | null = null;
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
    reflectKind = null;
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

    reflectKind = installKindControls(folder, layer, store);

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
    reflectKind?.(layer);
    updateReorder();
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
  subscriptions.on(store, (s) => s.seedPlacementLayerId, sync);
  subscriptions.on(store, (s) => s.traceNotices, sync); // the seed note reports what the last retrace did
  subscriptions.on(uiStore, (s) => s.isLayerSettingsOpen, applyVisible);

  return () => {
    subscriptions.dispose();
    dispose();
    disposeColormap();
    win.dispose();
  };
}
