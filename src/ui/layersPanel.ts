import type { Layer, LayerKind, SimulationStore, UiStore } from "@store";
import { makeEl, makeIconButton } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";
import { ICON_CLOSE } from "./icons.ts";
import { isTypingTarget } from "./keyboard.ts";
import {
  ICON_CARET_DOWN,
  ICON_CARET_UP,
  ICON_EYE,
  ICON_EYE_OFF,
  ICON_GEAR,
  LAYER_KIND_ICON,
} from "./layerIcons.ts";
import { POPOVER_GAP_PX } from "./layout.ts";

// The Layers overlay (DESIGN §"Layers & navigation"): a rail-toggled, fixed, translucent panel — one
// row per renderable instance, top (draw order) first. Each row: eye (show/hide) · kind + field
// (click selects — the colorbar retargets to that layer's binding) · gear (selects in M4.7, opens the
// per-layer settings panel in M4.8) · ▲/▼ reorder. ui → store only; hides with the global UI toggle.
// Fixed-position by design (drag/resize/persist is M7); reorder is buttons, not a drag system.

const KIND_LABEL: Record<LayerKind, string> = {
  volume: "Volume",
  slice: "Slice",
  fieldlines: "Lines",
  particles: "Particles",
};

const RAIL_FALLBACK_LEFT_PX = 52; // left anchor when the rail isn't mounted (headless tests)

interface RowRefs {
  readonly root: HTMLElement;
  readonly up: HTMLButtonElement;
  readonly down: HTMLButtonElement;
}

export function installLayersPanel(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const ac = new AbortController();
  const { signal } = ac;

  const root = makeEl(doc, "div", "webpic-layers");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Layers");
  root.hidden = true;

  const header = makeEl(doc, "div", "webpic-layers_header");
  const title = makeEl(doc, "span", "webpic-layers_title");
  title.textContent = "Layers";
  const closeBtn = makeIconButton(doc, "webpic-layers_close", ICON_CLOSE, { ariaLabel: "Close" });
  header.append(title, closeBtn);
  const listEl = makeEl(doc, "div", "webpic-layers_list");
  root.append(header, listEl);
  parent.appendChild(root);

  // id → reorder buttons, so a selection change toggles highlight without a full rebuild, and a
  // reorder click can restore focus to the moved row's button after the list re-renders.
  let rows = new Map<string, RowRefs>();
  let pendingFocus: { readonly id: string; readonly dir: "up" | "down" } | null = null;

  const dispatch = store.getState;

  const makeRow = (layer: Layer, index: number, count: number): RowRefs => {
    const row = makeEl(doc, "div", "webpic-layers_row");
    row.dataset.id = layer.id;
    if (layer.id === dispatch().selectedLayerId) row.classList.add("is-selected");

    const eye = makeIconButton(doc, "webpic-layers_eye", layer.visible ? ICON_EYE : ICON_EYE_OFF, {
      ariaLabel: layer.visible ? "Hide layer" : "Show layer",
    });
    eye.setAttribute("aria-pressed", String(layer.visible));
    eye.addEventListener("click", () => dispatch().setLayerVisible(layer.id, !layer.visible));

    const main = makeEl(doc, "button", "webpic-layers_main");
    main.type = "button";
    const kind = makeEl(doc, "span", "webpic-layers_kind");
    kind.innerHTML = LAYER_KIND_ICON[layer.kind];
    const name = makeEl(doc, "span", "webpic-layers_name");
    name.textContent = `${KIND_LABEL[layer.kind]} ${layer.field}`;
    main.append(kind, name);
    main.addEventListener("click", () => dispatch().selectLayer(layer.id));

    const gear = makeIconButton(doc, "webpic-layers_gear", ICON_GEAR, {
      ariaLabel: "Layer settings",
    });
    gear.addEventListener("click", () => dispatch().selectLayer(layer.id));

    const reorder = makeEl(doc, "div", "webpic-layers_reorder");
    const up = makeIconButton(doc, "webpic-layers_move", ICON_CARET_UP, { ariaLabel: "Move up" });
    up.disabled = index === 0;
    up.addEventListener("click", () => {
      pendingFocus = { id: layer.id, dir: "up" };
      dispatch().reorderLayer(layer.id, index - 1);
    });
    const down = makeIconButton(doc, "webpic-layers_move", ICON_CARET_DOWN, {
      ariaLabel: "Move down",
    });
    down.disabled = index === count - 1;
    down.addEventListener("click", () => {
      pendingFocus = { id: layer.id, dir: "down" };
      dispatch().reorderLayer(layer.id, index + 1);
    });
    reorder.append(up, down);

    row.append(eye, main, gear, reorder);
    return { root: row, up, down };
  };

  const render = (): void => {
    const { layers } = store.getState();
    listEl.replaceChildren();
    rows = new Map();
    if (layers.length === 0) {
      const empty = makeEl(doc, "div", "webpic-layers_empty");
      empty.textContent = "No layers — add one from the rail.";
      listEl.appendChild(empty);
      return;
    }
    layers.forEach((layer, index) => {
      const refs = makeRow(layer, index, layers.length);
      listEl.appendChild(refs.root);
      rows.set(layer.id, refs);
    });
    // Restore focus after a reorder rebuild — keep the moved control under the keyboard.
    if (pendingFocus !== null) {
      const refs = rows.get(pendingFocus.id);
      const btn = pendingFocus.dir === "up" ? refs?.up : refs?.down;
      // The end-stop button disables on arrival; fall back to its sibling so focus never strands.
      if (btn !== undefined && !btn.disabled) btn.focus();
      else if (refs !== undefined) (pendingFocus.dir === "up" ? refs.down : refs.up).focus();
      pendingFocus = null;
    }
  };

  const applySelection = (selectedId: string | null): void => {
    for (const [id, refs] of rows) refs.root.classList.toggle("is-selected", id === selectedId);
  };

  // Anchor to the rail's right edge (robust to rail width/theme); vertical placement is CSS-fixed.
  const position = (): void => {
    const rail = parent.querySelector(".webpic-siderail");
    const right = rail instanceof HTMLElement ? rail.getBoundingClientRect().right : 0;
    const left = (right > 0 ? right : RAIL_FALLBACK_LEFT_PX) + POPOVER_GAP_PX;
    root.style.left = `${Math.round(left)}px`;
  };

  const applyVisible = (): void => {
    const visible = uiStore.getState().isUiVisible && uiStore.getState().isLayersPanelOpen;
    root.hidden = !visible;
    if (visible) {
      render();
      position();
    }
  };

  closeBtn.addEventListener("click", () => uiStore.getState().setLayersPanelVisible(false), {
    signal,
  });

  // The Layers shortcut (DESIGN default "L"); ignored while typing or with modifiers held.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    if (isTypingTarget(event.target)) return;
    if (event.key.toLowerCase() === "l") uiStore.getState().toggleLayersPanel();
  };
  doc.addEventListener("keydown", onKeyDown, { signal });
  doc.defaultView?.addEventListener(
    "resize",
    () => {
      if (!root.hidden) position();
    },
    { signal },
  );

  applyVisible();

  const unsubs = [
    store.subscribe(
      (s) => s.layers,
      () => {
        if (!root.hidden) render();
      },
    ),
    store.subscribe((s) => s.selectedLayerId, applySelection),
    uiStore.subscribe((s) => s.isLayersPanelOpen, applyVisible),
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
  ];

  return () => {
    ac.abort();
    for (const unsub of unsubs) unsub();
    root.remove();
  };
}
