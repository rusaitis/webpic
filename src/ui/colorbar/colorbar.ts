import { type ColormapBinding, DEFAULT_COLORMAP } from "@schema/colormap.ts";
import type { Layer, SimulationStore, UiStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import type { Disposer } from "../controls/index.ts";
import { installDragSnap, type PaneEdge } from "../floating/dragSnap.ts";
import { paintGradient, tickLabels } from "./colorbarGradient.ts";
import { installColorbarSettings } from "./colorbarSettings.ts";

// The floating colorbar: a draggable, collapsible gradient strip for the selected layer's color
// mapping. It magnetically snaps to a viewport edge (left/right → vertical, top/bottom → horizontal)
// and springs clear of the chrome (rails, top bar, docked shell) so it attaches to an edge without
// covering the centered camera rail. The gear opens a popover hosting the colormap/scale/window
// controls. ui → store only: it reads the active ColormapBinding and repaints; edits flow through the
// popover's intents. Hides with the global UI toggle. Chrome state (edge/collapsed/position) is
// ephemeral DOM state — reset each load, like magviz.

// Static chrome the colorbar must not cover on drop; zero-area (hidden) matches are skipped. The
// bottom rail's tight per-button rects (not its full-width .webpic-rail container, which can't be
// cleared by a sideways nudge) so the strip slides past the centered cluster.
const CHROME_SELECTOR =
  ".webpic-rail_btn, .webpic-coords-card, .webpic-topbar, .webpic-siderail, .webpic-shell, .webpic-chrome, .webpic-status";
const INITIAL_GAP_PX = 12; // first-paint inset (bottom-right); reflow then clears the chrome
const TICK_COUNT = 5;

const ICON = {
  // Sliders — "adjust the colormap": two tracks with knobs.
  settings: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h6M11 5h3M2 11h3M8 11h6"/><circle cx="9.5" cy="5" r="1.6"/><circle cx="6.5" cy="11" r="1.6"/></svg>`,
  // Chevron — collapse/expand; CSS rotates it per edge + collapsed state.
  chevron: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5"/></svg>`,
} as const;

export function installColorbar(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;

  const container = makeEl(doc, "div", "webpic-cbar");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Colorbar");
  container.dataset.edge = "bottom";

  const caption = makeEl(doc, "span", "webpic-cbar_caption");

  // The gradient strip and its tick labels stack (column for horizontal, row for vertical) inside
  // a "main" box so the labels sit beside the gradient rather than over it.
  const main = makeEl(doc, "div", "webpic-cbar_main");
  const strip = makeEl(doc, "div", "webpic-cbar_strip");
  const canvas = doc.createElement("canvas");
  canvas.className = "webpic-cbar_canvas";
  strip.append(canvas);
  const ticks = makeEl(doc, "div", "webpic-cbar_ticks");
  main.append(strip, ticks);

  const actions = makeEl(doc, "div", "webpic-cbar_actions");
  actions.dataset.noDrag = ""; // never start a drag from the controls cluster
  const settingsBtn = makeEl(doc, "button", "webpic-cbar_btn webpic-cbar_settings");
  settingsBtn.type = "button";
  settingsBtn.setAttribute("aria-label", "Colormap settings");
  settingsBtn.setAttribute("aria-haspopup", "dialog");
  settingsBtn.setAttribute("aria-expanded", "false");
  settingsBtn.innerHTML = ICON.settings;
  const collapseBtn = makeEl(doc, "button", "webpic-cbar_btn webpic-cbar_collapse");
  collapseBtn.type = "button";
  collapseBtn.setAttribute("aria-label", "Collapse colorbar");
  collapseBtn.innerHTML = ICON.chevron;
  actions.append(settingsBtn, collapseBtn);

  container.append(caption, main, actions);
  container.style.right = `${INITIAL_GAP_PX}px`;
  container.style.bottom = `${INITIAL_GAP_PX}px`;
  parent.appendChild(container);

  const activeLayer = (): Layer | null => {
    const { selectedLayerId, layers } = store.getState();
    if (selectedLayerId === null) return null;
    return layers.find((l) => l.id === selectedLayerId) ?? null;
  };
  const activeBinding = (): ColormapBinding | null => {
    const { colormapBindings } = store.getState();
    const id = activeLayer()?.colormapBindingId ?? null;
    if (id === null) return null;
    return colormapBindings[id] ?? null;
  };

  const renderTicks = (binding: ColormapBinding | null): void => {
    ticks.replaceChildren();
    if (binding === null) return;
    for (const tk of tickLabels(binding.window, binding.scale, TICK_COUNT)) {
      const span = makeEl(doc, "span", "webpic-cbar_tick");
      span.style.setProperty("--t", `${tk.t}`);
      span.textContent = tk.label;
      ticks.appendChild(span);
    }
  };

  const repaint = (): void => {
    const edge = (container.dataset.edge as PaneEdge) ?? "bottom";
    const horizontal = edge === "top" || edge === "bottom";
    // Always render at the orientation's expanded pixel size; CSS scales the displayed strip
    // (incl. the collapse transition), so the canvas never snaps.
    canvas.width = horizontal ? 360 : 24;
    canvas.height = horizontal ? 24 : 220;
    const binding = activeBinding();
    paintGradient(canvas, binding?.colormap ?? DEFAULT_COLORMAP, horizontal);
    caption.textContent = binding?.field ?? "—";
    renderTicks(binding);
  };

  const settings = installColorbarSettings({
    parent,
    anchor: settingsBtn,
    colorbar: container,
    store,
  });
  settingsBtn.addEventListener("click", () => settings.toggle());

  const drag = installDragSnap(container, {
    chromeSelector: CHROME_SELECTOR,
    onEdgeChange: () => {
      repaint();
      settings.reposition();
    },
  });

  const setCollapsed = (next: boolean): void => {
    container.classList.toggle("collapsed", next);
    collapseBtn.setAttribute("aria-label", next ? "Expand colorbar" : "Collapse colorbar");
    collapseBtn.setAttribute("aria-pressed", String(next));
    drag.reflow(); // size changed → re-dock flush + re-clear chrome
    settings.reposition();
  };
  collapseBtn.addEventListener("click", () =>
    setCollapsed(!container.classList.contains("collapsed")),
  );

  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (!visible) settings.close();
  };

  repaint();
  applyVisible(uiStore.getState().isUiVisible);
  // Settle clear of the chrome once layout (and thus rects) are valid.
  doc.defaultView?.requestAnimationFrame(() => drag.reflow());

  const unsubSelected = store.subscribe((s) => s.selectedLayerId, repaint);
  const unsubRange = store.subscribe((s) => s.dataRange, repaint);
  const unsubBinding = store.subscribe((s) => {
    const layer =
      s.selectedLayerId === null ? undefined : s.layers.find((l) => l.id === s.selectedLayerId);
    const id = layer?.colormapBindingId ?? null;
    return id === null ? null : (s.colormapBindings[id] ?? null);
  }, repaint);
  const unsubVisible = uiStore.subscribe((s) => s.isUiVisible, applyVisible);

  return () => {
    unsubVisible();
    unsubBinding();
    unsubRange();
    unsubSelected();
    drag.dispose();
    settings.dispose();
    container.remove();
  };
}
