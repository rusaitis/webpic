import { clamp } from "@schema/math.ts";
import { VIEWPORT_MARGIN_PX } from "../layout.ts";
import { coalesceFrame } from "../pointerMath.ts";
import { installPressDrag } from "./pressDrag.ts";
import {
  type Box,
  box,
  chooseEdge,
  EDGE_GAP_PX,
  freePlacement,
  isPaneEdge,
  type PaneEdge,
  pushOutOf,
  type SnapPlacement,
  type Viewport,
} from "./snapGeometry.ts";

export type { Box, PaneEdge, SnapPlacement, Viewport };

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
  // free drop). The colorbar options in; the free-mode window keeps corner anchoring.
  readonly centerFreeAxis?: boolean;
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
  const writeOffset = (x: number, y: number): void => {
    element.style.setProperty("--drag-x", `${x}px`);
    element.style.setProperty("--drag-y", `${y}px`);
  };

  const setAnchors = (
    h: "left" | "right",
    v: "top" | "bottom",
    left: number,
    top: number,
    w: number,
    hgt: number,
    vp: Viewport,
  ): void => {
    if (h === "left") {
      element.style.left = `${left}px`;
      element.style.right = "auto";
    } else {
      element.style.right = `${vp.width - left - w}px`;
      element.style.left = "auto";
    }
    if (v === "top") {
      element.style.top = `${top}px`;
      element.style.bottom = "auto";
    } else {
      element.style.bottom = `${vp.height - top - hgt}px`;
      element.style.top = "auto";
    }
  };

  // Center-anchor the free axis (CSS translate(-50%) on it pivots a resize on the center); pin the
  // docked axis to its edge. The visual top-left still resolves to (left, top); only the resize pivot
  // changes. A free drop (docked=false) centers both axes.
  const placeCentered = (
    edge: PaneEdge,
    isDocked: boolean,
    left: number,
    top: number,
    w: number,
    hgt: number,
    vp: Viewport,
  ): void => {
    const centerX = (): void => {
      element.style.left = `${left + w / 2}px`;
      element.style.right = "auto";
    };
    const centerY = (): void => {
      element.style.top = `${top + hgt / 2}px`;
      element.style.bottom = "auto";
    };
    if (!isDocked) {
      centerX();
      centerY();
      return;
    }
    if (edge === "top" || edge === "bottom") {
      centerX(); // horizontal is free → center it
      if (edge === "bottom") {
        element.style.bottom = `${vp.height - top - hgt}px`;
        element.style.top = "auto";
      } else {
        element.style.top = `${top}px`;
        element.style.bottom = "auto";
      }
    } else {
      centerY(); // vertical is free → center it
      if (edge === "right") {
        element.style.right = `${vp.width - left - w}px`;
        element.style.left = "auto";
      } else {
        element.style.left = `${left}px`;
        element.style.right = "auto";
      }
    }
  };

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
    const set = (left: number, top: number): void => {
      if (options.centerFreeAxis) {
        placeCentered(placement.edge, placement.isDocked, left, top, w, h, vp);
      } else {
        setAnchors(placement.h, placement.v, left, top, w, h, vp);
      }
    };
    set(placement.left, placement.top);
    // A free drop stays where released; only a docked element springs clear of the rails/bars.
    if (!placement.isDocked) return box(placement.left, placement.top, w, h);
    const cleared = pushOutOf(
      box(placement.left, placement.top, w, h),
      obstacles(),
      placement.edge,
      vp,
    );
    if (cleared.left !== placement.left || cleared.top !== placement.top) {
      set(cleared.left, cleared.top);
      return box(cleared.left, cleared.top, w, h);
    }
    return box(placement.left, placement.top, w, h);
  };

  const snap = (): void => {
    const vp = viewport();
    const r = element.getBoundingClientRect(); // visual drop position (includes the drag transform)
    if (options.mode === "free") {
      const { left, top } = freePlacement(box(r.left, r.top, r.width, r.height), vp);
      writeOffset(0, 0);
      setAnchors("left", "top", left, top, r.width, r.height, vp);
      return;
    }
    const prevEdge = readEdge(element);
    const placement = chooseEdge(box(r.left, r.top, r.width, r.height), vp, prevEdge);
    writeOffset(0, 0);
    element.dataset.docked = placement.isDocked ? "true" : "false";
    const settled = apply(placement, r.width, r.height, vp);
    if (placement.edge !== prevEdge) {
      element.dataset.edge = placement.edge;
      options.onEdgeChange?.(placement.edge);
    }
    options.onSettled?.(placement.edge, settled, vp);
  };

  // Re-settle after a resize or a size change: re-flush a docked edge, hold a free drop in place,
  // then re-clear chrome. A collapse/expand needs no anchor change under centerFreeAxis — the CSS
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
      const { left, top } = freePlacement(box(r.left, r.top, r.width, r.height), vp);
      setAnchors("left", "top", left, top, r.width, r.height, vp);
      return;
    }
    const edge = readEdge(element) ?? "bottom";
    const isDocked = element.dataset.docked !== "false";
    const maxLeft = Math.max(VIEWPORT_MARGIN_PX, vp.width - r.width - VIEWPORT_MARGIN_PX);
    const maxTop = Math.max(VIEWPORT_MARGIN_PX, vp.height - r.height - VIEWPORT_MARGIN_PX);

    // Re-flush a docked element to its edge; a free drop keeps its current visual position.
    let left = r.left;
    let top = r.top;
    if (isDocked) {
      if (edge === "left") left = EDGE_GAP_PX;
      if (edge === "right") left = vp.width - r.width - EDGE_GAP_PX;
      if (edge === "top") top = EDGE_GAP_PX;
      if (edge === "bottom") top = vp.height - r.height - EDGE_GAP_PX;
    }
    left = clamp(left, VIEWPORT_MARGIN_PX, maxLeft);
    top = clamp(top, VIEWPORT_MARGIN_PX, maxTop);

    if (options.centerFreeAxis) {
      const settled = apply(
        { edge, h: "left", v: "top", left, top, isDocked },
        r.width,
        r.height,
        vp,
      );
      options.onSettled?.(edge, settled, vp);
      return;
    }
    // Corner-anchor path (no center pivot): anchor the free axis to the nearer side so the
    // element tracks that edge on the next resize instead of drifting from a stale fixed offset.
    let h: "left" | "right";
    let v: "top" | "bottom";
    if (edge === "left" || edge === "right") {
      h = edge;
      v = top + r.height / 2 > vp.height / 2 ? "bottom" : "top";
    } else {
      h = left + r.width / 2 > vp.width / 2 ? "right" : "left";
      v = edge;
    }
    const settled = apply({ edge, h, v, left, top, isDocked }, r.width, r.height, vp);
    options.onSettled?.(edge, settled, vp);
  };

  installPressDrag({
    handle,
    element,
    activeClass: "is-dragging",
    signal,
    onStart: (event) => {
      const target = event.target as Element | null; // EventTarget → Element narrowing for closest()
      if (target?.closest("button, input, select, textarea, a, [data-no-drag]")) return false;
      baseX = readVar("--drag-x");
      baseY = readVar("--drag-y");
      return true;
    },
    onMove: (dx, dy) => writeOffset(baseX + dx, baseY + dy),
    onEnd: () => {
      snap();
      recentlyDragged = true; // suppress the trailing click; a microtask is too early
      view?.setTimeout(() => {
        recentlyDragged = false;
      }, 0);
    },
  });

  const onClick = (e: MouseEvent): void => {
    if (!recentlyDragged) return;
    e.preventDefault();
    e.stopPropagation();
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
