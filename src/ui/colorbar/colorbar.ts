import { type ColormapBinding, type ColormapId, DEFAULT_COLORMAP } from "@schema/colormap.ts";
import { type SimulationStore, selectActiveBinding, type UiStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import type { Disposer } from "../controls/index.ts";
import { type Box, installDragSnap, type PaneEdge, type Viewport } from "../floating/dragSnap.ts";
import { bottomDockLayout } from "./bottomDock.ts";
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
} as const;

export function installColorbar(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const view = doc.defaultView;

  const container = makeEl(doc, "div", "webpic-cbar");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Colorbar");
  container.dataset.edge = "bottom";

  const caption = makeEl(doc, "span", "webpic-cbar_caption");

  // The caption, gradient strip, and tick labels stack inside "main": column for horizontal docks
  // (caption above the gradient, ticks below) and row for vertical (caption to the left) — magviz.
  const main = makeEl(doc, "div", "webpic-cbar_main");
  const strip = makeEl(doc, "div", "webpic-cbar_strip");
  const canvas = doc.createElement("canvas");
  canvas.className = "webpic-cbar_canvas";
  // Collapsed-only overlay: the field key painted faintly over the gradient (magviz), so a docked
  // strip still names its field without the expanded side caption. Empty → hidden by CSS.
  const miniLabel = makeEl(doc, "span", "webpic-cbar_minilabel");
  miniLabel.setAttribute("aria-hidden", "true");
  strip.append(canvas, miniLabel);
  const ticks = makeEl(doc, "div", "webpic-cbar_ticks");
  main.append(caption, strip, ticks);

  const actions = makeEl(doc, "div", "webpic-cbar_actions");
  actions.dataset.noDrag = ""; // never start a drag from the controls cluster
  const settingsBtn = makeEl(doc, "button", "webpic-cbar_btn webpic-cbar_settings");
  settingsBtn.type = "button";
  settingsBtn.setAttribute("aria-label", "Colormap settings");
  settingsBtn.setAttribute("aria-haspopup", "dialog");
  settingsBtn.setAttribute("aria-expanded", "false");
  settingsBtn.innerHTML = ICON.settings;
  actions.append(settingsBtn);

  container.append(main, actions);
  container.style.bottom = `${INITIAL_GAP_PX}px`; // first-paint dock; left set after repaint sizes it
  parent.appendChild(container);

  // Last-painted gradient inputs: resizing the canvas clears its bitmap and re-baking the 64-stop
  // gradient is wasted on a window/scale/field edit (only the ticks move), so both are gated on a
  // real change of orientation/colormap.
  let paintedHorizontal: boolean | null = null;
  let paintedColormap: ColormapId | null = null;

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
    const binding = selectActiveBinding(store.getState());
    const colormap = binding?.colormap ?? DEFAULT_COLORMAP;
    // Render at the orientation's expanded pixel size; CSS scales the displayed strip (incl. the
    // collapse transition), so the canvas never snaps. A resize clears the bitmap, so any resize
    // forces a gradient repaint; a colormap change repaints in place.
    const orientationChanged = paintedHorizontal !== horizontal;
    if (orientationChanged) {
      canvas.width = horizontal ? 360 : 24;
      canvas.height = horizontal ? 24 : 220;
    }
    if (orientationChanged || paintedColormap !== colormap) {
      paintGradient(canvas, colormap, horizontal);
    }
    paintedHorizontal = horizontal;
    paintedColormap = colormap;
    caption.textContent = binding?.field ?? "—";
    // No placeholder over the gradient — empty hides the collapsed overlay (CSS `:not(:empty)`).
    miniLabel.textContent = binding?.field ?? "";
    renderTicks(binding);
  };

  const settings = installColorbarSettings({
    parent,
    anchor: settingsBtn,
    colorbar: container,
    store,
  });
  settingsBtn.addEventListener("click", () => settings.toggle());

  // Bottom-rail co-centering (magviz parity): when the strip docks to the bottom edge near the
  // centered button rail, slide the rail's cluster aside so the two read as one centered group; drop
  // it elsewhere (or another edge) and the rail re-centers alone. The rail consumes --webpic-rail-shift
  // as a translateX; the colorbar owns the value since it knows its own docked geometry — the same
  // direct-DOM coupling it already uses to read the rail buttons as drag obstacles.
  const railClusterWidth = (): number => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const btn of doc.querySelectorAll(".webpic-rail_btn")) {
      const r = btn.getBoundingClientRect();
      if (r.width <= 0) continue;
      lo = Math.min(lo, r.left);
      hi = Math.max(hi, r.right);
    }
    return hi > lo ? hi - lo : 0; // translate-invariant: a shifted rail reports the same width
  };
  const cornerWidgetRight = (): number => {
    const gnomon = doc.querySelector(".webpic-gnomon");
    if (gnomon === null) return 0;
    const r = gnomon.getBoundingClientRect();
    return r.width > 0 ? r.right : 0;
  };
  const setRailShift = (px: number): void => {
    doc
      .querySelector<HTMLElement>(".webpic-rail")
      ?.style.setProperty("--webpic-rail-shift", `${Math.round(px)}px`);
  };
  const recenterRail = (edge: PaneEdge, settled: Box, vp: Viewport): void => {
    // Only a strip actually docked flush to the bottom edge joins the rail's group; a free drop in
    // the middle keeps edge="bottom" only as an orientation hint, so it must leave the rail centered.
    if (edge !== "bottom" || container.dataset.docked === "false" || container.hidden) {
      setRailShift(0);
      return;
    }
    const dock = bottomDockLayout({
      colorbar: settled,
      clusterWidth: railClusterWidth(),
      viewportWidth: vp.width,
      cornerClearRight: cornerWidgetRight(),
    });
    setRailShift(dock.railShift);
    if (dock.grouped && dock.colorbarLeft !== null) {
      // Override the dock's horizontal placement with the grouped slot. The strip is center-anchored
      // on the bottom edge (CSS translateX(-50%)), so the inline left is the slot's center; the
      // bottom (flush) anchor stays untouched.
      container.style.left = `${Math.round(dock.colorbarLeft + settled.width / 2)}px`;
      container.style.right = "auto";
    }
  };

  const drag = installDragSnap(container, {
    chromeSelector: CHROME_SELECTOR,
    centerFreeAxis: true, // collapse/expand pivots on the strip's center, not an edge
    onEdgeChange: () => {
      repaint();
      settings.reposition();
    },
    onSettled: recenterRail,
  });

  let settleTimer: number | undefined;
  const setCollapsed = (next: boolean): void => {
    container.classList.toggle("collapsed", next);
    // The strip resizes around its center via CSS (translate -50% on the free axis), so the position
    // needs no anchor change. Reflow only re-clamps into the viewport and (when docked beside the
    // rail) re-groups for the new width — once now, once after the ~0.28s size transition settles.
    drag.reflow();
    settings.reposition();
    if (settleTimer !== undefined) view?.clearTimeout(settleTimer);
    settleTimer = view?.setTimeout(() => {
      drag.reflow();
      settings.reposition();
    }, 320);
  };
  // Click anywhere on the bar toggles collapse (magviz), except the gear or a just-ended drag's
  // trailing click. The settings popover is body-appended, so its clicks never reach here.
  container.addEventListener("click", (e) => {
    if (drag.wasDragging()) return;
    const target = e.target as Element | null;
    if (target?.closest("button, a, input, select, [data-no-drag]")) return;
    setCollapsed(!container.classList.contains("collapsed"));
  });

  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (visible) {
      // Re-settle once layout (and thus rects) are valid, recomputing the rail co-centering.
      view?.requestAnimationFrame(() => drag.reflow());
    } else {
      settings.close();
      setRailShift(0); // a hidden colorbar must not hold the rail off-center
    }
  };

  repaint();
  // Initial bottom-right dock in center-anchor form (the bottom edge is center-anchored on x via CSS
  // translateX(-50%)): place the strip's center so its right edge sits INITIAL_GAP from the viewport.
  const initialWidth = container.getBoundingClientRect().width;
  container.style.left = `${Math.round(doc.documentElement.clientWidth - INITIAL_GAP_PX - initialWidth / 2)}px`;
  container.style.right = "auto";
  applyVisible(uiStore.getState().isUiVisible);

  // One subscription drives the strip: the active binding's reference changes on layer-select,
  // colormap, scale, or window edits — every input the strip reads. (dataRange feeds the settings
  // slider's track, not the strip, so it needs no repaint here.)
  const unsubBinding = store.subscribe(selectActiveBinding, repaint);
  const unsubVisible = uiStore.subscribe((s) => s.isUiVisible, applyVisible);
  // The gnomon toggle resizes the rail's footprint (its reserved corner + cluster shift), so re-settle
  // the co-centering after the rail's own subscriber has repainted (next frame).
  const unsubGnomon = store.subscribe(
    (s) => s.overlay.showGnomon,
    () => view?.requestAnimationFrame(() => drag.reflow()),
  );

  return () => {
    if (settleTimer !== undefined) view?.clearTimeout(settleTimer);
    setRailShift(0);
    unsubGnomon();
    unsubVisible();
    unsubBinding();
    drag.dispose();
    settings.dispose();
    container.remove();
  };
}
