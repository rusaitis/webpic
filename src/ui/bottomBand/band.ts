import type { SimulationStore, UiStore } from "@store";
import type { Box, PaneEdge, Viewport } from "../floating/dragSnap.ts";
import { readEdge } from "../floating/dragSnap.ts";
import { coalesceFrame } from "../pointerMath.ts";
import { createSubscriptions } from "../subscriptions.ts";
import { bottomDockLayout, colorbarFitMode, isRailGnomonCramped } from "./dock.ts";

// The bottom band coordinator: the one place that knows the bottom row's occupants — the centered
// button rail, the corner gnomon, and a strip docked flush on the bottom edge — and lays them out as
// a group. Two jobs on top of the pure geometry in colorbar/bottomDock: co-centering (a docked strip
// slides the rail's cluster aside via --webpic-rail-shift, and the two read as one group), and the
// responsive fit (as the band narrows the strip auto-minimizes, then migrates up a side edge; a rail
// that can't clear the gnomon's corner reserve sheds it). The strip owns its DOM, the band the timing.

// The rail flex-shrinks its buttons + coords chip to fit beside the gnomon, so a *measured* cluster
// understates how wide it wants to be. Treat it as un-squished (its natural width) only when this much
// slack remains on each side of the centered cluster (the 80px gnomon reserve + breathing room).
const NATURAL_CLUSTER_SLACK_PX = 96;
// The strip's collapse/expand size transition (~0.28 s) plus margin: measure once it has settled.
const SETTLE_MS = 320;
const COLLAPSED_WIDTH_ESTIMATE_PX = 132; // collapsed strip + gear + padding, until first measured
const NATURAL_CLUSTER_ESTIMATE_PX = 320; // un-squished rail (buttons + coords chip), until measured

interface BottomBandHost {
  readonly store: SimulationStore;
  readonly uiStore: UiStore;
  // The bottom-docked strip: read for its rect + edge/docked state, positioned when grouped.
  readonly strip: HTMLElement;
  isCollapsed(): boolean;
  // A fit decision: apply the collapse/expand; the band reflows now and re-fits once settled.
  setCollapsed(next: boolean): void;
  // A fit decision: dock to `side` (reorient); the band reflows now and again once settled.
  migrateToSide(side: PaneEdge): void;
  // Re-clamp the strip into the viewport + re-group beside the rail (dragSnap reflow + popover).
  reflow(): void;
}

export interface BottomBand {
  // dragSnap's onSettled hook: co-center the rail with a strip docked flush on the bottom row.
  onSettled(edge: PaneEdge, settled: Box, vp: Viewport): void;
  // The user toggled collapse by hand: collapse control is theirs until the next fit decision.
  collapse(next: boolean): void;
  // The strip changed shape in place (a strip added/removed): re-clamp now, re-fit once settled.
  restack(): void;
  // Strip shown / hidden: shown re-fits once laid out; hidden releases the rail + gnomon.
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createBottomBand(host: BottomBandHost): BottomBand {
  const { store, uiStore, strip } = host;
  const doc = strip.ownerDocument;
  const view = doc.defaultView;
  // `isAutoCollapsed` flags a fit-driven collapse so widening can undo it without clobbering a manual
  // one. Both rendered widths are cached at settle time so the predictive fit never measures a
  // mid-collapse strip (and stays monotonic in width — no expand↔collapse oscillation).
  let isAutoCollapsed = false;
  let expandedWidth = 0;
  let collapsedWidth = COLLAPSED_WIDTH_ESTIMATE_PX;
  let naturalCluster = NATURAL_CLUSTER_ESTIMATE_PX;
  let settleTimer: number | undefined;

  const viewportWidth = (): number => doc.documentElement.clientWidth;
  const isOnBottomRow = (): boolean =>
    readEdge(strip) === "bottom" && strip.dataset.docked !== "false";

  const railClusterWidth = (): number => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const btn of doc.querySelectorAll(".webpic-rail_btn")) {
      const rect = btn.getBoundingClientRect();
      if (rect.width <= 0) continue;
      lo = Math.min(lo, rect.left);
      hi = Math.max(hi, rect.right);
    }
    return hi > lo ? hi - lo : 0; // translate-invariant: a shifted rail reports the same width
  };
  const cornerWidgetRight = (): number => {
    const gnomon = doc.querySelector(".webpic-gnomon");
    if (gnomon === null) return 0;
    const rect = gnomon.getBoundingClientRect();
    return rect.width > 0 ? rect.right : 0;
  };
  const setRailShift = (px: number): void => {
    doc
      .querySelector<HTMLElement>(".webpic-rail")
      ?.style.setProperty("--webpic-rail-shift", `${Math.round(px)}px`);
  };

  const onSettled = (edge: PaneEdge, settled: Box, vp: Viewport): void => {
    // Only a strip actually docked flush to the bottom edge joins the rail's group; a free drop in
    // the middle keeps edge="bottom" only as an orientation hint, so it must leave the rail centered.
    if (edge !== "bottom" || strip.dataset.docked === "false" || strip.hidden) {
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
    if (dock.isGrouped && dock.colorbarLeft !== null) {
      // Override the dock's horizontal placement with the grouped slot. The strip is center-anchored
      // on the bottom edge (CSS translateX(-50%)), so the inline left is the slot's center; the
      // bottom (flush) anchor stays untouched.
      strip.style.left = `${Math.round(dock.colorbarLeft + settled.width / 2)}px`;
      strip.style.right = "auto";
    }
  };

  const scheduleSettle = (after: () => void): void => {
    if (settleTimer !== undefined) view?.clearTimeout(settleTimer);
    settleTimer = view?.setTimeout(after, SETTLE_MS);
  };
  const cacheWidth = (): void => {
    if (host.isCollapsed()) collapsedWidth = strip.getBoundingClientRect().width;
    else expandedWidth = strip.getBoundingClientRect().width;
  };
  // A size change in place: re-clamp/re-group now, then re-measure the settled size + re-fit.
  const settle = (): void => {
    host.reflow();
    scheduleSettle(() => {
      host.reflow();
      cacheWidth();
      adapt();
    });
  };
  const setCollapsed = (next: boolean, auto: boolean): void => {
    isAutoCollapsed = auto ? next : false; // a manual toggle hands collapse control back to the user
    host.setCollapsed(next);
    settle();
  };

  // Migrate the strip off the crowded bottom row to the nearer side edge (vertical), clearing the rail
  // entirely. It stays where it lands — widening won't auto-return it (the user can drag it back).
  const migrateToSide = (): void => {
    const rect = strip.getBoundingClientRect();
    const side: PaneEdge = rect.left + rect.width / 2 >= viewportWidth() / 2 ? "right" : "left";
    if (readEdge(strip) === side) return;
    host.migrateToSide(side);
    host.reflow(); // flush to the side edge, springing clear of the side rail / top bar
    scheduleSettle(() => host.reflow());
  };

  // Half one of the fit pass, independent of the strip: the gnomon hides when the rail can't clear
  // it. Refreshes the cached natural width whenever the rail clearly isn't squished against the
  // corner, and judges cramping off that — the live width collapses with the viewport and would
  // never trip. Returns the verdict, which the strip half needs for the corner footprint.
  const syncGnomonSuppression = (viewport: number, cluster: number): boolean => {
    if (cluster > 0 && (viewport - cluster) / 2 > NATURAL_CLUSTER_SLACK_PX)
      naturalCluster = cluster;
    const wasSuppressed = uiStore.getState().isGnomonSuppressed;
    const shouldSuppress = isRailGnomonCramped(
      viewport,
      Math.max(naturalCluster, cluster),
      wasSuppressed,
    );
    if (shouldSuppress !== wasSuppressed) uiStore.getState().setGnomonSuppressed(shouldSuppress);
    return shouldSuppress;
  };

  // Half two: minimize, then migrate, a strip that can't sit beside the rail.
  const fitStrip = (viewport: number, cluster: number, isGnomonSuppressed: boolean): void => {
    const mode = colorbarFitMode({
      viewportWidth: viewport,
      clusterWidth: cluster,
      cornerClearRight: isGnomonSuppressed ? 0 : cornerWidgetRight(),
      expandedWidth,
      collapsedWidth,
    });
    if (mode === "expanded") {
      if (host.isCollapsed() && isAutoCollapsed) setCollapsed(false, true);
    } else if (mode === "collapsed") {
      if (!host.isCollapsed()) setCollapsed(true, true);
    } else if (!host.isCollapsed()) {
      setCollapsed(true, true); // minimize first; the settle re-adapt migrates if it still won't fit
    } else {
      migrateToSide();
    }
  };

  // Idempotent + monotonic in viewport width, so the triggers below can fire it freely without
  // oscillating. Only a strip docked on the bottom row beside a rail adapts; side/top docks and
  // free drops keep the gnomon pass and stop.
  const adapt = (): void => {
    if (strip.hidden) return;
    const viewport = viewportWidth();
    const cluster = railClusterWidth();
    const isGnomonSuppressed = syncGnomonSuppression(viewport, cluster);
    if (!isOnBottomRow() || cluster <= 0) return;
    fitStrip(viewport, cluster, isGnomonSuppressed);
  };

  const scheduleAdapt = coalesceFrame(view, adapt);

  // The band reshapes on a window resize, the gnomon toggle (corner footprint), and a new dataset
  // (the coords chip widens the cluster) — re-fit on each. The gnomon's own show/hide handles the
  // rail co-centering via dragSnap's chrome ResizeObserver; here we just re-evaluate the fit. The
  // suppression echo re-fits once the corner footprint has settled; the guarded setter makes it a
  // single no-op rather than a loop.
  const subscriptions = createSubscriptions();
  const abortController = new AbortController();
  view?.addEventListener("resize", scheduleAdapt, { signal: abortController.signal });
  subscriptions.add(() => abortController.abort());
  subscriptions.on(store, (s) => s.overlay.showGnomon, scheduleAdapt);
  subscriptions.on(store, (s) => s.dataset, scheduleAdapt);
  subscriptions.on(uiStore, (s) => s.isGnomonSuppressed, scheduleAdapt);

  const release = (): void => {
    setRailShift(0); // a hidden strip must not hold the rail off-center…
    uiStore.getState().setGnomonSuppressed(false); // …nor the gnomon suppressed
  };

  return {
    onSettled,
    collapse: (next) => setCollapsed(next, false),
    restack: settle,
    setVisible(visible) {
      if (!visible) {
        release();
        return;
      }
      // Re-settle once layout (and thus rects) are valid: co-centering, the settled width, the fit.
      view?.requestAnimationFrame(() => {
        host.reflow();
        cacheWidth();
        adapt();
      });
    },
    dispose() {
      if (settleTimer !== undefined) view?.clearTimeout(settleTimer);
      subscriptions.dispose();
      release();
    },
  };
}
