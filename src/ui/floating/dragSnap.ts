import { isInteractiveTarget } from "../controls/dom.ts";
import { clampIntoViewport } from "../layout.ts";
import { coalesceFrame } from "../pointerMath.ts";
import { createAnchorWriter } from "./anchorWriter.ts";
import { bindPressDrag } from "./pressDrag.ts";
import {
  type Box,
  box,
  chooseEdge,
  flushedToEdge,
  freePlacement,
  isPaneEdge,
  leaningAnchors,
  type PaneEdge,
  pushOutOf,
  type SnapPlacement,
  type Viewport,
} from "./snapGeometry.ts";

export type { Box, PaneEdge, Viewport };

// Pointer-driven drag for a single floating element (the colorbar, the Developer window). Movement
// rides CSS custom properties --drag-x / --drag-y consumed by a `transform: translate(...)` in the
// stylesheet; on release snapGeometry decides where it lands and this writes that out as inline
// left/right/top/bottom anchors plus a `data-edge` the CSS reorients on. AbortController-scoped
// listeners; no module-global stacking.

// The dock edge held in `data-edge` — written here on snap, seeded by the owner — or undefined when
// unset. Validated against the literal set, so every reader gets a typed edge without a cast.
export function readEdge(element: HTMLElement): PaneEdge | undefined {
  const edge = element.dataset.edge;
  return edge !== undefined && isPaneEdge(edge) ? edge : undefined;
}

export interface DragSnapOptions {
  // "snap" (default) magnetically docks to the nearest edge on release; "free" just clamps the
  // drop position into the viewport and anchors top-left (a movable window, no docking).
  readonly mode?: "snap" | "free";
  // Element receiving pointerdown to start a drag. Defaults to the dragged element.
  readonly handle?: HTMLElement;
  // CSS selector for static chrome the element must not cover when dropped. Zero-area
  // (hidden) matches are skipped.
  readonly chromeSelector?: string;
  // Anchor the *free* axis (the one not pinned to a dock edge) by its center rather than a corner,
  // so a size change (collapse/expand) pivots on the center. The stylesheet must translate that axis
  // by -50% (`translateX(-50%)` on top/bottom docks, `translateY(-50%)` on left/right, both for a
  // free drop). The colorbar opts in; the free-mode window keeps corner anchoring.
  readonly shouldCenterFreeAxis?: boolean;
  // Fired when the dock edge changes (the colorbar repaints its gradient orientation).
  readonly onEdgeChange?: (edge: PaneEdge) => void;
  // Fired after every settle (drag release, reflow, resize) with the element's resolved edge + box,
  // so a consumer can co-layout neighbouring chrome (the colorbar re-centers the bottom rail). It
  // may write the element's own anchors; it must not resize tracked chrome (that would re-trigger).
  readonly onSettled?: (edge: PaneEdge, settled: Box, vp: Viewport) => void;
}

export interface DragSnapController {
  // Re-settle against the current edge + chrome — call after a size change (collapse/expand) or
  // once after mount so the initial placement clears the chrome.
  reflow(): void;
  // True for one tick after a drag release — so a click-to-toggle handler on the element can skip
  // the trailing click a drag generates.
  wasDragging(): boolean;
  dispose(): void;
}

export function installDragSnap(
  element: HTMLElement,
  options: DragSnapOptions = {},
): DragSnapController {
  const handle = options.handle ?? element;
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const anchors = createAnchorWriter(element, options.shouldCenterFreeAxis === true);
  const abortController = new AbortController();
  const { signal } = abortController;

  let baseX = 0;
  let baseY = 0;
  let recentlyDragged = false;
  let chromeObserver: ResizeObserver | null = null;

  const viewport = (): Viewport => ({
    width: doc.documentElement.clientWidth,
    height: doc.documentElement.clientHeight,
  });
  const readVar = (name: string): number =>
    Number.parseFloat(element.style.getPropertyValue(name)) || 0;
  const obstacles = (): Box[] => {
    if (!options.chromeSelector) return [];
    const out: Box[] = [];
    for (const node of doc.querySelectorAll<HTMLElement>(options.chromeSelector)) {
      if (node === element || element.contains(node)) continue;
      chromeObserver?.observe(node); // re-clear if this chrome later resizes (re-observe is a no-op)
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push(box(r.left, r.top, r.width, r.height));
    }
    return out;
  };

  // Place `placement` via inline anchors, then spring a docked element clear of chrome along the dock
  // axis. Returns the resolved (visual top-left) box so the caller can hand it to onSettled — the live
  // rect would read the mid-transition value, not the target.
  const apply = (placement: SnapPlacement, w: number, h: number, vp: Viewport): Box => {
    const at = box(placement.left, placement.top, w, h);
    anchors.write(placement, at, vp);
    // A free drop stays where released; only a docked element springs clear of the rails/bars.
    if (!placement.isDocked) return at;
    const cleared = pushOutOf(at, obstacles(), placement.edge, vp);
    if (cleared.left === placement.left && cleared.top === placement.top) return at;
    const sprung = box(cleared.left, cleared.top, w, h);
    anchors.write(placement, sprung, vp);
    return sprung;
  };

  // A free-mode element only ever clamps into the viewport, top-left anchored.
  const placeFree = (rect: Box, vp: Viewport): void => {
    const { left, top } = freePlacement(rect, vp);
    anchors.write(
      { edge: "top", h: "left", v: "top", left, top, isDocked: false },
      box(left, top, rect.width, rect.height),
      vp,
    );
  };

  const snap = (): void => {
    const vp = viewport();
    const r = element.getBoundingClientRect(); // visual drop position (includes the drag transform)
    if (options.mode === "free") {
      anchors.offset(0, 0);
      placeFree(box(r.left, r.top, r.width, r.height), vp);
      return;
    }
    const prevEdge = readEdge(element);
    const placement = chooseEdge(box(r.left, r.top, r.width, r.height), vp, prevEdge);
    anchors.offset(0, 0);
    element.dataset.docked = placement.isDocked ? "true" : "false";
    const settled = apply(placement, r.width, r.height, vp);
    if (placement.edge !== prevEdge) {
      element.dataset.edge = placement.edge;
      options.onEdgeChange?.(placement.edge);
    }
    options.onSettled?.(placement.edge, settled, vp);
  };

  // Re-settle after a resize or a size change: re-flush a docked edge, hold a free drop in place,
  // then re-clear chrome. A collapse/expand needs no anchor change under shouldCenterFreeAxis — the CSS
  // -50% translate keeps the free axis pivoting on its center — this just re-clamps + re-groups.
  const reflow = (): void => {
    const hasInline =
      element.style.left !== "" ||
      element.style.right !== "" ||
      element.style.top !== "" ||
      element.style.bottom !== "";
    if (!hasInline) return;
    const vp = viewport();
    const r = element.getBoundingClientRect();
    // A hidden (display:none) or detached element measures 0×0; reflowing it would anchor it to the
    // viewport origin and clobber its initial inline placement. Keep the inline anchors until it's laid
    // out — floatingWindow re-runs reflow on show, so a default-hidden window settles when first shown.
    if (r.width === 0 && r.height === 0) return;
    if (options.mode === "free") {
      placeFree(box(r.left, r.top, r.width, r.height), vp);
      return;
    }
    const edge = readEdge(element) ?? "bottom";
    const isDocked = element.dataset.docked !== "false";
    const flushed = flushedToEdge(box(r.left, r.top, r.width, r.height), edge, isDocked, vp);
    const { left, top } = clampIntoViewport(
      { left: flushed.left, top: flushed.top, width: r.width, height: r.height },
      vp,
    );

    // Under shouldCenterFreeAxis the CSS -50% translate owns the free axis, so h/v carry no information.
    const { h, v } = options.shouldCenterFreeAxis
      ? ({ h: "left", v: "top" } as const)
      : leaningAnchors(edge, box(left, top, r.width, r.height), vp);
    const settled = apply({ edge, h, v, left, top, isDocked }, r.width, r.height, vp);
    options.onSettled?.(edge, settled, vp);
  };

  bindPressDrag({
    handle,
    element,
    activeClass: "is-dragging",
    signal,
    onStart: (event) => {
      if (isInteractiveTarget(event)) return false;
      baseX = readVar("--drag-x");
      baseY = readVar("--drag-y");
      return true;
    },
    onMove: (dx, dy) => anchors.offset(baseX + dx, baseY + dy),
    onEnd: () => {
      snap();
      recentlyDragged = true; // suppress the trailing click; a microtask is too early
      view?.setTimeout(() => {
        recentlyDragged = false;
      }, 0);
    },
  });

  const onClick = (event: MouseEvent): void => {
    if (!recentlyDragged) return;
    event.preventDefault();
    event.stopPropagation();
    recentlyDragged = false;
  };

  element.addEventListener("click", onClick, { capture: true, signal });

  const scheduleReflow = coalesceFrame(view, reflow);
  view?.addEventListener("resize", scheduleReflow, { signal });
  // Re-clear when a chrome obstacle changes size — e.g. the coords chip widens once a dataset loads,
  // after the strip already docked against its old (empty) width. obstacles() registers each node;
  // moving the strip never resizes chrome, so this can't loop. (No ResizeObserver under jsdom.)
  const RO = view?.ResizeObserver;
  if (RO && options.chromeSelector) chromeObserver = new RO(scheduleReflow);

  return {
    reflow,
    wasDragging: () => recentlyDragged,
    dispose() {
      chromeObserver?.disconnect();
      abortController.abort();
    },
  };
}
