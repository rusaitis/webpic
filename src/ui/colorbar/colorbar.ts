import { type ColormapBinding, type ColormapId, DEFAULT_COLORMAP } from "@schema/colormap.ts";
import { FIELD_REGISTRY } from "@schema/registry.ts";
import { type SimulationStore, selectActiveBinding, type UiStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import type { Disposer } from "../controls/index.ts";
import { type Box, installDragSnap, type PaneEdge, type Viewport } from "../floating/dragSnap.ts";
import { installRaise } from "../floating/zStack.ts";
import { bottomDockLayout, colorbarFitMode, railGnomonCramped } from "./bottomDock.ts";
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
// One nice-number target for BOTH orientations, so the tick values are identical horizontal and
// vertical (the set depends only on the window + this count — never the strip's pixel length). 5
// reads well on the 320px-wide horizontal strip without crowding and leaves the 200px vertical one
// with room to spare (stacked labels are short).
const TICK_TARGET = 5;
// The rail flex-shrinks its buttons + coords chip to fit beside the gnomon, so a *measured* cluster
// understates how wide it wants to be. Treat it as un-squished (its natural width) only when this much
// slack remains on each side of the centered cluster (the 80px gnomon reserve + breathing room).
const NATURAL_CLUSTER_SLACK_PX = 96;

// Expanded caption: the field key plus its SI unit in brackets when the field has one ("|B| [T]").
// The collapsed mini-label stays bare (just the key) — units only read in the expanded view.
const captionText = (field: string | undefined): string => {
  if (field === undefined || field.length === 0) return "—";
  const unit = FIELD_REGISTRY[field]?.siUnit;
  return unit !== undefined && unit.length > 0 ? `${field} [${unit}]` : field;
};

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
  const disposeRaise = installRaise(container); // clicking the strip lifts it over the floating windows

  // Last-painted gradient inputs: resizing the canvas clears its bitmap and re-baking the 64-stop
  // gradient is wasted on a window/scale/field edit (only the ticks move), so both are gated on a
  // real change of orientation/colormap.
  let paintedHorizontal: boolean | null = null;
  let paintedColormap: ColormapId | null = null;

  const renderTicks = (binding: ColormapBinding | null): void => {
    ticks.replaceChildren();
    if (binding === null) return;
    for (const tk of tickLabels(binding.window, binding.scale, TICK_TARGET)) {
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
    caption.textContent = captionText(binding?.field);
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

  // Adaptive bottom-band fit (responsive): when the docked strip can't sit beside the centered rail it
  // auto-minimizes, then migrates up a side edge; an over-narrow rail also sheds the gnomon. Both
  // rendered widths are cached at settle time so the predictive fit never measures a mid-collapse strip
  // (and so it stays monotonic in width — no expand↔collapse oscillation). `autoCollapsed` flags a
  // fit-driven collapse so widening can undo it without clobbering a manual collapse.
  let autoCollapsed = false;
  let expandedWidth = 0;
  let collapsedWidth = 132; // estimate (collapsed strip + gear + padding) until first measured
  let naturalCluster = 320; // cached un-squished rail width (≈ buttons + coords chip) until measured
  const viewportWidth = (): number => doc.documentElement.clientWidth;
  const isCollapsed = (): boolean => container.classList.contains("collapsed");

  let settleTimer: number | undefined;
  const scheduleSettle = (after: () => void): void => {
    if (settleTimer !== undefined) view?.clearTimeout(settleTimer);
    settleTimer = view?.setTimeout(after, 320);
  };
  const setCollapsed = (next: boolean, auto = false): void => {
    autoCollapsed = auto ? next : false; // a manual toggle hands collapse control back to the user
    container.classList.toggle("collapsed", next);
    // The strip resizes around its center via CSS (translate -50% on the free axis), so the position
    // needs no anchor change. Reflow only re-clamps into the viewport and (when docked beside the
    // rail) re-groups for the new width — once now, once after the ~0.28s size transition settles.
    drag.reflow();
    settings.reposition();
    scheduleSettle(() => {
      drag.reflow();
      settings.reposition();
      // Cache the now-settled width for the active mode, then re-evaluate (collapse→migrate / restore).
      if (isCollapsed()) collapsedWidth = container.getBoundingClientRect().width;
      else expandedWidth = container.getBoundingClientRect().width;
      adapt();
    });
  };

  // Migrate the strip off the crowded bottom row to the nearer side edge (vertical), clearing the rail
  // entirely. It stays where it lands — widening won't auto-return it (the user can drag it back).
  const migrateToSide = (): void => {
    const r = container.getBoundingClientRect();
    const side: PaneEdge = r.left + r.width / 2 >= viewportWidth() / 2 ? "right" : "left";
    if (container.dataset.edge === side) return;
    container.dataset.edge = side;
    container.dataset.docked = "true";
    repaint(); // reorient the gradient to vertical
    drag.reflow(); // flush to the side edge, springing clear of the side rail / top bar
    settings.reposition();
    scheduleSettle(() => {
      drag.reflow();
      settings.reposition();
    });
  };

  // The bottom-band fit pass: suppress the gnomon when the rail can't clear it (independent of the
  // strip), then minimize / migrate the strip if it can't sit beside the rail. Idempotent + monotonic
  // in viewport width, so the triggers below can fire it freely without oscillating.
  const adapt = (): void => {
    if (container.hidden) return;
    const vw = viewportWidth();
    const cluster = railClusterWidth();
    // Refresh the cached natural width whenever the rail clearly isn't squished against the corner;
    // judge cramping off that (the live width collapses with the viewport and would never trip).
    if (cluster > 0 && (vw - cluster) / 2 > NATURAL_CLUSTER_SLACK_PX) naturalCluster = cluster;
    const wasSuppressed = uiStore.getState().isGnomonSuppressed;
    const suppress = railGnomonCramped(vw, Math.max(naturalCluster, cluster), wasSuppressed);
    if (suppress !== wasSuppressed) uiStore.getState().setGnomonSuppressed(suppress);

    // The strip only adapts while docked on the bottom row beside a rail; side/top docks + free drops
    // keep their place.
    if (container.dataset.edge !== "bottom" || container.dataset.docked === "false" || cluster <= 0)
      return;
    const mode = colorbarFitMode({
      viewportWidth: vw,
      clusterWidth: cluster,
      cornerClearRight: suppress ? 0 : cornerWidgetRight(),
      expandedWidth,
      collapsedWidth,
    });
    if (mode === "expanded") {
      if (isCollapsed() && autoCollapsed) setCollapsed(false, true);
    } else if (mode === "collapsed") {
      if (!isCollapsed()) setCollapsed(true, true);
    } else if (!isCollapsed()) {
      setCollapsed(true, true); // minimize first; the settle re-adapt migrates if it still won't fit
    } else {
      migrateToSide();
    }
  };

  let adaptScheduled = false;
  const scheduleAdapt = (): void => {
    if (adaptScheduled || !view) return;
    adaptScheduled = true;
    view.requestAnimationFrame(() => {
      adaptScheduled = false;
      adapt();
    });
  };

  // Click anywhere on the bar toggles collapse (magviz), except the gear or a just-ended drag's
  // trailing click. The settings popover is body-appended, so its clicks never reach here.
  container.addEventListener("click", (e) => {
    if (drag.wasDragging()) return;
    const target = e.target as Element | null;
    if (target?.closest("button, a, input, select, [data-no-drag]")) return;
    setCollapsed(!isCollapsed()); // manual (auto = false): the user owns collapse from here
  });

  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (visible) {
      // Re-settle once layout (and thus rects) are valid: rail co-centering + the responsive fit.
      view?.requestAnimationFrame(() => {
        drag.reflow();
        adapt();
      });
    } else {
      settings.close();
      setRailShift(0); // a hidden colorbar must not hold the rail off-center
      uiStore.getState().setGnomonSuppressed(false); // …nor hold the gnomon suppressed
    }
  };

  repaint();
  // Initial bottom-right dock in center-anchor form (the bottom edge is center-anchored on x via CSS
  // translateX(-50%)): place the strip's center so its right edge sits INITIAL_GAP from the viewport.
  const initialWidth = container.getBoundingClientRect().width;
  expandedWidth = initialWidth; // seed the predictive fit's expanded width (first paint is expanded)
  container.style.left = `${Math.round(doc.documentElement.clientWidth - INITIAL_GAP_PX - initialWidth / 2)}px`;
  container.style.right = "auto";
  applyVisible(uiStore.getState().isUiVisible);

  // One subscription drives the strip: the active binding's reference changes on layer-select,
  // colormap, scale, or window edits — every input the strip reads. (dataRange feeds the settings
  // slider's track, not the strip, so it needs no repaint here.)
  const unsubBinding = store.subscribe(selectActiveBinding, repaint);
  const unsubVisible = uiStore.subscribe((s) => s.isUiVisible, applyVisible);
  // The bottom band reshapes on a window resize, the gnomon toggle (corner footprint), and a new
  // dataset (the coords chip widens the cluster) — re-fit on each. The gnomon's own show/hide handles
  // the rail co-centering via dragSnap's chrome ResizeObserver; here we just re-evaluate the fit.
  view?.addEventListener("resize", scheduleAdapt);
  const unsubGnomon = store.subscribe((s) => s.overlay.showGnomon, scheduleAdapt);
  const unsubDataset = store.subscribe((s) => s.dataset, scheduleAdapt);
  // Re-fit once our own suppression write has settled the gnomon's corner footprint; the guarded
  // setter makes the echo a single no-op rather than a loop.
  const unsubSuppressed = uiStore.subscribe((s) => s.isGnomonSuppressed, scheduleAdapt);

  return () => {
    if (settleTimer !== undefined) view?.clearTimeout(settleTimer);
    view?.removeEventListener("resize", scheduleAdapt);
    setRailShift(0);
    uiStore.getState().setGnomonSuppressed(false);
    unsubSuppressed();
    unsubDataset();
    unsubGnomon();
    unsubVisible();
    unsubBinding();
    disposeRaise();
    drag.dispose();
    settings.dispose();
    container.remove();
  };
}
