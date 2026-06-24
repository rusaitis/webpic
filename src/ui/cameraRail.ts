import type { CameraProjection, SimulationStore, UiStore } from "@store";
import { installOutsideClickDismiss, makeEl, makeIconButton } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";
import {
  COORDINATE_UNITS,
  coordsLabel,
  formatCenter,
  formatOrientation,
  GEOMETRY_LABEL,
  gridInfoRows,
} from "./coordsInfo.ts";
import { isTypingTarget } from "./keyboard.ts";

// Centered bottom button rail (magviz's bottom-cluster, cleaned up to webpic's structure): subtle
// icon controls for the gnomon, orbit/fly mode, projection, and a momentary fit-to-view (the one
// touch path to Z, since iPads have no keyboard), a text "coords" chip that names the loaded
// coordinate frame + its spatial units and opens a grid-info card, and a help button.
// ui → store only — every button dispatches a typed intent or reads a slice; no render import.
// "Gnomon-aware": it reserves the bottom-left gnomon's footprint (the has-gnomon inset) so the centered
// cluster never slides under it. Hides with the global UI toggle, like ui/cameraChrome.

// 16×16 inline SVGs (no icon-font dep). `stroke: currentColor; fill: none` come from the rail CSS, so
// the whole button tints together; per-icon fills opt back in where a glyph wants a solid mark.
const ICON = {
  gnomon: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h10M3 13V3M3 13l4.5-3.5"/></svg>`,
  orbit: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1"/><path d="M13.6 2.6V6H10.2"/></svg>`,
  fly: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.5 1.5 1.8 6.9l4.9 1.6 1.6 4.9z"/><path d="M14.5 1.5 6.7 8.5"/></svg>`,
  perspective: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.7 2 13.5 4.2v6L7.7 12.4 2 10.2v-6z"/><path d="M7.7 2v6.2l5.8-2M7.7 8.2 2 6"/></svg>`,
  ortho: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h8v8h-8z"/><path d="M5.5 5.5V2.5h8v8h-3"/></svg>`,
  fit: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5V2h3.5M14 5.5V2h-3.5M2 10.5V14h3.5M14 10.5V14h-3.5"/></svg>`,
  help: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.8c-.7.4-1 .8-1 1.5"/><circle cx="7.9" cy="12" r=".55" fill="currentColor" stroke="none"/></svg>`,
} as const;

export function installCameraRail(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const ac = new AbortController();
  const { signal } = ac;
  const container = makeEl(doc, "div", "webpic-rail");
  container.setAttribute("role", "toolbar");
  container.setAttribute("aria-label", "View controls");

  const makeButton = (control: string, extra: string, icon: string): HTMLButtonElement =>
    makeIconButton(doc, extra ? `webpic-rail_btn ${extra}` : "webpic-rail_btn", icon, { control });

  const gnomonBtn = makeButton("gnomon", "", ICON.gnomon);
  const flyBtn = makeButton("fly", "", ICON.orbit);
  const projBtn = makeButton("projection", "", ICON.perspective);
  const fitBtn = makeButton("fit", "", ICON.fit);
  fitBtn.title = "Fit data to view (Z)";
  const coordsBtn = makeButton("coords", "webpic-rail_coords", "");
  const helpBtn = makeButton("help", "", ICON.help);
  helpBtn.title = "Keyboard shortcuts (? / H)";

  coordsBtn.setAttribute("aria-haspopup", "dialog");
  coordsBtn.setAttribute("aria-expanded", "false");
  coordsBtn.title = "Coordinates & grid info (C)";

  gnomonBtn.addEventListener(
    "click",
    () => {
      const state = store.getState();
      state.setOverlayShowGnomon(!state.overlay.showGnomon);
    },
    { signal },
  );
  flyBtn.addEventListener("click", () => store.getState().toggleFlyMode(), { signal });
  projBtn.addEventListener(
    "click",
    () => {
      const state = store.getState();
      state.setProjection(state.projection === "orthographic" ? "perspective" : "orthographic");
    },
    { signal },
  );
  // Momentary, not a toggle: re-frame the data (pointerCamera owns the fit math + glide).
  fitBtn.addEventListener("click", () => store.getState().requestCameraFly({ kind: "fit" }), {
    signal,
  });
  coordsBtn.addEventListener("click", () => uiStore.getState().toggleCoordsInfo(), { signal });
  helpBtn.addEventListener("click", () => uiStore.getState().toggleHelp(), { signal });

  container.append(gnomonBtn, flyBtn, projBtn, fitBtn, coordsBtn, helpBtn);
  parent.appendChild(container);

  // Grid-info card: a parent-level floating dialog (not a rail child) so it escapes the rail's
  // stacking context + dimmed-button opacity, and opens above the centered cluster. Built once; the
  // grid rows rebuild on a dataset change while open, the View + Center rows track the live pose.
  // Read-only — preserving/sharing the current view is a future top-menu concern, not the card's.
  const card = makeEl(doc, "div", "webpic-coords-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Coordinates and grid info");
  card.hidden = true;

  const appendRow = (host: HTMLElement, label: string, value: string): HTMLSpanElement => {
    const row = makeEl(doc, "div", "webpic-coords-card_row");
    const l = makeEl(doc, "span", "webpic-coords-card_label");
    l.textContent = label;
    const v = makeEl(doc, "span", "webpic-coords-card_value");
    v.textContent = value;
    row.append(l, v);
    host.appendChild(row);
    return v;
  };

  const rowsHost = makeEl(doc, "div", "webpic-coords-card_rows");
  card.append(rowsHost);
  // Two pose rows: the camera's orientation/zoom, then the world point it orbits (the view center).
  const viewValue = appendRow(card, "View", "");
  const centerValue = appendRow(card, "Center", "");
  parent.appendChild(card);

  // Coordinate-system name: the loaded frame ("lab", "GSM", …), falling back to the grid geometry if a
  // dataset omits one. The chip pairs it with the spatial units — both independent of the shown field.
  const applyCoordsLabel = (): void => {
    const { dataset } = store.getState();
    if (dataset === null) {
      coordsBtn.textContent = coordsLabel(null, "");
      return;
    }
    const name = dataset.frame.trim() || GEOMETRY_LABEL[dataset.grid.geometry];
    coordsBtn.textContent = coordsLabel(name, COORDINATE_UNITS);
  };

  const renderGridRows = (): void => {
    rowsHost.replaceChildren();
    const { dataset } = store.getState();
    if (dataset === null) {
      appendRow(rowsHost, "Dataset", "none loaded");
      return;
    }
    for (const [label, value] of gridInfoRows(dataset.grid, dataset.frame, COORDINATE_UNITS)) {
      appendRow(rowsHost, label, value);
    }
  };

  const updateViewRow = (): void => {
    const { cameraPose, projection } = store.getState();
    // Fires per gesture frame while the card is open; the integer-rounded readouts repeat across
    // most sub-degree frames, so skip the write when unchanged (textContent is the cache).
    const view = formatOrientation(cameraPose, projection === "orthographic");
    if (viewValue.textContent !== view) viewValue.textContent = view;
    const center = formatCenter(cameraPose);
    if (centerValue.textContent !== center) centerValue.textContent = center;
  };

  // Reflect store state onto the toggles: aria-pressed for assistive tech + styling, a swapped icon
  // and tooltip for the two mode toggles, and the has-gnomon inset that keeps the cluster centered.
  // The button reflects the user's preference; the has-gnomon inset (reserving the corner footprint so
  // the centered cluster never slides under the gnomon) follows the *effective* visibility — when the
  // gnomon is responsively suppressed (band too narrow, ui/colorbar's flag) it's gone, so reserve
  // nothing and let the cluster use the full width.
  const applyGnomon = (show: boolean): void => {
    gnomonBtn.setAttribute("aria-pressed", String(show));
    gnomonBtn.title = show ? "Hide orientation gnomon" : "Show orientation gnomon";
    container.classList.toggle("has-gnomon", show && !uiStore.getState().isGnomonSuppressed);
  };
  const applyFly = (fly: boolean): void => {
    flyBtn.setAttribute("aria-pressed", String(fly));
    flyBtn.innerHTML = fly ? ICON.fly : ICON.orbit;
    flyBtn.title = fly
      ? "Fly mode — A/D/Q/E look, W/S walk · click or N to orbit"
      : "Orbit mode — click or N for fly (first-person look)";
  };
  const applyProjection = (projection: CameraProjection): void => {
    const ortho = projection === "orthographic";
    projBtn.setAttribute("aria-pressed", String(ortho));
    projBtn.innerHTML = ortho ? ICON.ortho : ICON.perspective;
    projBtn.title = ortho
      ? "Orthographic — click or O for perspective"
      : "Perspective — click or O for orthographic";
  };
  const isOpen = (): boolean => uiStore.getState().isCoordsInfoVisible;
  const applyInfoVisible = (visible: boolean): void => {
    card.hidden = !visible;
    coordsBtn.setAttribute("aria-expanded", String(visible));
    if (visible) {
      renderGridRows();
      updateViewRow();
    }
  };
  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (visible) applyCoordsLabel();
    // Don't leave the card floating over a hidden UI; F re-reveals the rail, not the card.
    else uiStore.getState().setCoordsInfoVisible(false);
  };

  applyGnomon(store.getState().overlay.showGnomon);
  applyFly(store.getState().isFlyMode);
  applyProjection(store.getState().projection);
  applyCoordsLabel();
  applyInfoVisible(uiStore.getState().isCoordsInfoVisible);
  applyVisible(uiStore.getState().isUiVisible);

  // Escape closes; bare `C` toggles (skipped while typing / under a modifier — Cmd+C stays copy);
  // an outside pointer-down dismisses (shared installOutsideClickDismiss, like the side-rail flyout).
  const onDocKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if (event.key === "Escape") {
      if (isOpen()) uiStore.getState().setCoordsInfoVisible(false);
      return;
    }
    if (event.code === "KeyC" && !event.shiftKey) {
      event.preventDefault();
      uiStore.getState().toggleCoordsInfo();
    }
  };
  doc.addEventListener("keydown", onDocKeyDown, { signal });
  const disposeOutsideDismiss = installOutsideClickDismiss(doc, {
    overlay: card,
    trigger: coordsBtn,
    isOpen,
    onDismiss: () => uiStore.getState().setCoordsInfoVisible(false),
  });

  const renderRowsIfOpen = (): void => {
    if (isOpen()) renderGridRows();
  };
  const updateViewIfOpen = (): void => {
    if (isOpen()) updateViewRow();
  };

  const unsubs = [
    store.subscribe((s) => s.overlay.showGnomon, applyGnomon),
    // Re-apply the inset when the responsive suppression flips (gnomon hidden/shown without a
    // preference change), so the cluster reclaims / yields the corner footprint.
    uiStore.subscribe(
      (s) => s.isGnomonSuppressed,
      () => applyGnomon(store.getState().overlay.showGnomon),
    ),
    store.subscribe((s) => s.isFlyMode, applyFly),
    store.subscribe(
      (s) => s.projection,
      (projection) => {
        applyProjection(projection);
        updateViewIfOpen(); // the View row's ortho suffix follows
      },
    ),
    store.subscribe(
      (s) => s.dataset,
      () => {
        applyCoordsLabel();
        renderRowsIfOpen();
      },
    ),
    store.subscribe((s) => s.cameraPose, updateViewIfOpen),
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
    uiStore.subscribe((s) => s.isCoordsInfoVisible, applyInfoVisible),
  ];

  return () => {
    ac.abort();
    for (const unsub of unsubs) unsub();
    disposeOutsideDismiss();
    container.remove();
    card.remove();
  };
}
