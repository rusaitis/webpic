import { clamp } from "@schema/math.ts";

// Pointer-driven drag + magnetic edge/corner snap for a single floating element (the colorbar).
// Movement during a drag rides CSS custom properties --drag-x / --drag-y consumed by a
// `transform: translate(...)` in the stylesheet; on release the element snaps flush to the nearest
// viewport edge (within EDGE_SNAP_PX) via inline left/right/top/bottom anchors, sets `data-edge`
// so the CSS reorients (left/right → vertical, top/bottom → horizontal), and springs clear of any
// registered chrome (the rails, top bar, docked shell) — so it attaches to an edge without ever
// covering the centered camera rail. A webpic-clean rewrite of magviz's draggablePanels (pure
// geometry split out for tests; AbortController-scoped listeners; no module-global stacking).

export type PaneEdge = "left" | "right" | "top" | "bottom";

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Where a snap wants to place the element: which edge it docks to, the anchor side per axis
 *  (so expand/collapse grows toward the viewport center), and the resolved top-left. */
export interface SnapPlacement {
  readonly edge: PaneEdge;
  readonly h: "left" | "right";
  readonly v: "top" | "bottom";
  readonly left: number;
  readonly top: number;
}

const DRAG_THRESHOLD_PX = 4;
const VIEWPORT_MARGIN_PX = 8; // keep this much of the element inside the viewport
const EDGE_SNAP_PX = 72; // dock to an edge when this close
const CORNER_SNAP_PX = 80; // pin both axes when this close to a corner
const EDGE_GAP_PX = 12; // breathing room from the edge / chrome when docked (matches the shell inset)
const STICKY_HYSTERESIS_PX = 120; // bias toward the current edge so tall/wide strips don't oscillate
const OVERLAP_EPSILON_PX = 0.5; // sub-pixel snap residue is not a collision

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/** `a < b`, biased by STICKY_HYSTERESIS_PX toward the element's current edge so a strip whose two
 *  opposite-edge distances are both small doesn't flip-flop on tiny drags. */
function stickyLess(
  a: number,
  b: number,
  prevEdge: PaneEdge | undefined,
  lowEdge: PaneEdge,
  highEdge: PaneEdge,
): boolean {
  if (prevEdge === lowEdge) return a <= b + STICKY_HYSTERESIS_PX;
  if (prevEdge === highEdge) return a + STICKY_HYSTERESIS_PX < b;
  return a <= b;
}

/** Resolve where `rect` should dock given the viewport and its previous edge. Snaps to a corner
 *  (both axes) or a single edge when within threshold; otherwise a free drop that still reorients
 *  `data-edge` across the viewport midline along the current axis. Pure — unit-tested. */
export function chooseEdge(rect: Box, vp: Viewport, prevEdge: PaneEdge | undefined): SnapPlacement {
  const { width: W, height: H } = vp;
  const distL = rect.left;
  const distR = W - rect.right;
  const distT = rect.top;
  const distB = H - rect.bottom;

  const nearH = distL < EDGE_SNAP_PX || distR < EDGE_SNAP_PX;
  const nearV = distT < EDGE_SNAP_PX || distB < EDGE_SNAP_PX;
  const cornerNearH = distL < CORNER_SNAP_PX || distR < CORNER_SNAP_PX;
  const cornerNearV = distT < CORNER_SNAP_PX || distB < CORNER_SNAP_PX;

  const dockLeft = W - rect.width - EDGE_GAP_PX; // left value when docked to the right edge
  const dockTop = H - rect.height - EDGE_GAP_PX; // top value when docked to the bottom edge

  if (cornerNearH && cornerNearV) {
    const leftSide = stickyLess(distL, distR, prevEdge, "left", "right");
    const topSide = stickyLess(distT, distB, prevEdge, "top", "bottom");
    // Orient along whichever axis gives the more natural strip (wider → horizontal).
    const edge: PaneEdge =
      rect.width >= rect.height ? (topSide ? "top" : "bottom") : leftSide ? "left" : "right";
    return {
      edge,
      h: leftSide ? "left" : "right",
      v: topSide ? "top" : "bottom",
      left: leftSide ? EDGE_GAP_PX : dockLeft,
      top: topSide ? EDGE_GAP_PX : dockTop,
    };
  }
  // Anchor the free axis to whichever side the strip leans toward, so it tracks that edge on the
  // next resize (a bottom-right strip stays glued to the right corner instead of drifting left as
  // the centered rail re-centers) rather than always pinning the low edge.
  if (nearH) {
    const leftSide = stickyLess(distL, distR, prevEdge, "left", "right");
    const topSide = stickyLess(distT, distB, prevEdge, "top", "bottom");
    return {
      edge: leftSide ? "left" : "right",
      h: leftSide ? "left" : "right",
      v: topSide ? "top" : "bottom",
      left: leftSide ? EDGE_GAP_PX : dockLeft,
      top: clamp(rect.top, VIEWPORT_MARGIN_PX, H - rect.height - VIEWPORT_MARGIN_PX),
    };
  }
  if (nearV) {
    const leftSide = stickyLess(distL, distR, prevEdge, "left", "right");
    const topSide = stickyLess(distT, distB, prevEdge, "top", "bottom");
    return {
      edge: topSide ? "top" : "bottom",
      h: leftSide ? "left" : "right",
      v: topSide ? "top" : "bottom",
      left: clamp(rect.left, VIEWPORT_MARGIN_PX, W - rect.width - VIEWPORT_MARGIN_PX),
      top: topSide ? EDGE_GAP_PX : dockTop,
    };
  }

  // Free drop: flip the edge across the midline along the element's current axis.
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const verticalAxis = prevEdge === "top" || prevEdge === "bottom";
  const edge: PaneEdge = verticalAxis
    ? stickyLess(cy, H - cy, prevEdge, "top", "bottom")
      ? "top"
      : "bottom"
    : stickyLess(cx, W - cx, prevEdge, "left", "right")
      ? "left"
      : "right";
  return {
    edge,
    h: edge === "right" ? "right" : "left",
    v: edge === "bottom" ? "bottom" : "top",
    left: clamp(rect.left, VIEWPORT_MARGIN_PX, W - rect.width - VIEWPORT_MARGIN_PX),
    top: clamp(rect.top, VIEWPORT_MARGIN_PX, H - rect.height - VIEWPORT_MARGIN_PX),
  };
}

/** Free-drag placement: clamp the rect's top-left into the viewport (keeping VIEWPORT_MARGIN_PX of
 *  the element on screen), no edge dock. Pure — unit-tested. */
export function freePlacement(rect: Box, vp: Viewport): { left: number; top: number } {
  return {
    left: clamp(
      rect.left,
      VIEWPORT_MARGIN_PX,
      Math.max(VIEWPORT_MARGIN_PX, vp.width - rect.width - VIEWPORT_MARGIN_PX),
    ),
    top: clamp(
      rect.top,
      VIEWPORT_MARGIN_PX,
      Math.max(VIEWPORT_MARGIN_PX, vp.height - rect.height - VIEWPORT_MARGIN_PX),
    ),
  };
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left + OVERLAP_EPSILON_PX < b.right &&
    a.right - OVERLAP_EPSILON_PX > b.left &&
    a.top + OVERLAP_EPSILON_PX < b.bottom &&
    a.bottom - OVERLAP_EPSILON_PX > b.top
  );
}

/** Single-axis pushes that clear `r` from `o` with EDGE_GAP_PX of room. When docked to an edge,
 *  only the axis *along* the dock is offered — a bottom-docked strip springs sideways, never off
 *  the screen. Free elements get all four and the smallest wins. */
function pushVectors(
  r: Box,
  o: Box,
  edge: PaneEdge | undefined,
): ReadonlyArray<{ dx: number; dy: number }> {
  const horiz = [
    { dx: o.right - r.left + EDGE_GAP_PX, dy: 0 },
    { dx: o.left - r.right - EDGE_GAP_PX, dy: 0 },
  ];
  const vert = [
    { dx: 0, dy: o.bottom - r.top + EDGE_GAP_PX },
    { dx: 0, dy: o.top - r.bottom - EDGE_GAP_PX },
  ];
  if (edge === "top" || edge === "bottom") return horiz;
  if (edge === "left" || edge === "right") return vert;
  return [...horiz, ...vert];
}

/** Spring `rect`'s top-left out of every obstacle by the minimum-translation axis, staying inside
 *  the viewport, and return the *least-overlapping reachable* position. Greedy push, but it keeps the
 *  best position seen (fewest overlaps, then least displacement) and stops on a revisited position —
 *  so a cramped edge where no fully-clear slot fits the element (e.g. a wide strip wedged between the
 *  centered rail and a full-height side panel) settles deterministically instead of oscillating. Pure.*/
export function pushOutOf(
  rect: Box,
  obstacles: readonly Box[],
  edge: PaneEdge | undefined,
  vp: Viewport,
): { left: number; top: number } {
  const maxLeft = Math.max(VIEWPORT_MARGIN_PX, vp.width - VIEWPORT_MARGIN_PX - rect.width);
  const maxTop = Math.max(VIEWPORT_MARGIN_PX, vp.height - VIEWPORT_MARGIN_PX - rect.height);
  const overlapCount = (b: Box): number =>
    obstacles.reduce((n, o) => n + (overlaps(b, o) ? 1 : 0), 0);

  let cur = rect;
  let best = rect;
  let bestOverlaps = overlapCount(rect);
  let bestDist = 0;
  const seen = new Set<string>();
  for (let iter = 0; iter < 12 && bestOverlaps > 0; iter++) {
    const key = `${Math.round(cur.left)},${Math.round(cur.top)}`;
    if (seen.has(key)) break; // revisited → cycle, no further progress
    seen.add(key);

    let push: { dx: number; dy: number } | null = null;
    let pushMag = Number.POSITIVE_INFINITY;
    for (const o of obstacles) {
      if (!overlaps(cur, o)) continue;
      for (const v of pushVectors(cur, o, edge)) {
        const m = Math.abs(v.dx) + Math.abs(v.dy); // single-axis → L1 == L2
        if (m > 0 && m < pushMag) {
          pushMag = m;
          push = v;
        }
      }
    }
    if (push === null) break;
    const left = clamp(cur.left + push.dx, VIEWPORT_MARGIN_PX, maxLeft);
    const top = clamp(cur.top + push.dy, VIEWPORT_MARGIN_PX, maxTop);
    cur = box(left, top, rect.width, rect.height);

    const oc = overlapCount(cur);
    const dist = Math.abs(left - rect.left) + Math.abs(top - rect.top);
    if (oc < bestOverlaps || (oc === bestOverlaps && dist < bestDist)) {
      best = cur;
      bestOverlaps = oc;
      bestDist = dist;
    }
  }
  return { left: best.left, top: best.top };
}

export interface DragSnapOptions {
  /** "snap" (default) magnetically docks to the nearest edge on release; "free" just clamps the
   *  drop position into the viewport and anchors top-left (a movable window, no docking). */
  readonly mode?: "snap" | "free";
  /** Element receiving pointerdown to start a drag. Defaults to the dragged element. */
  readonly handle?: HTMLElement;
  /** CSS selector for static chrome the element must not cover when dropped. Zero-area
   *  (hidden) matches are skipped. */
  readonly chromeSelector?: string;
  /** Fired when the dock edge changes (the colorbar repaints its gradient orientation). */
  readonly onEdgeChange?: (edge: PaneEdge) => void;
}

export interface DragSnapController {
  /** Re-settle against the current edge + chrome — call after a size change (collapse/expand) or
   *  once after mount so the initial placement clears the chrome. */
  reflow(): void;
  /** True for one tick after a drag release — so a click-to-toggle handler on the element can skip
   *  the trailing click a drag generates. */
  wasDragging(): boolean;
  dispose(): void;
}

export function installDragSnap(el: HTMLElement, opts: DragSnapOptions = {}): DragSnapController {
  const handle = opts.handle ?? el;
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const ac = new AbortController();
  const { signal } = ac;

  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  let active = false;
  let pointerId: number | null = null;
  let recentlyDragged = false;

  const viewport = (): Viewport => ({
    width: doc.documentElement.clientWidth,
    height: doc.documentElement.clientHeight,
  });
  const readVar = (name: string): number => Number.parseFloat(el.style.getPropertyValue(name)) || 0;
  const writeOffset = (x: number, y: number): void => {
    el.style.setProperty("--drag-x", `${x}px`);
    el.style.setProperty("--drag-y", `${y}px`);
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
      el.style.left = `${left}px`;
      el.style.right = "auto";
    } else {
      el.style.right = `${vp.width - left - w}px`;
      el.style.left = "auto";
    }
    if (v === "top") {
      el.style.top = `${top}px`;
      el.style.bottom = "auto";
    } else {
      el.style.bottom = `${vp.height - top - hgt}px`;
      el.style.top = "auto";
    }
  };

  const obstacles = (): Box[] => {
    if (!opts.chromeSelector) return [];
    const out: Box[] = [];
    for (const node of doc.querySelectorAll<HTMLElement>(opts.chromeSelector)) {
      if (node === el || el.contains(node)) continue;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push(box(r.left, r.top, r.width, r.height));
    }
    return out;
  };

  // Place `placement` via inline anchors, then spring clear of chrome along the dock axis.
  const apply = (placement: SnapPlacement, w: number, h: number, vp: Viewport): void => {
    setAnchors(placement.h, placement.v, placement.left, placement.top, w, h, vp);
    const cleared = pushOutOf(
      box(placement.left, placement.top, w, h),
      obstacles(),
      placement.edge,
      vp,
    );
    if (cleared.left !== placement.left || cleared.top !== placement.top) {
      setAnchors(placement.h, placement.v, cleared.left, cleared.top, w, h, vp);
    }
  };

  const snap = (): void => {
    const vp = viewport();
    const r = el.getBoundingClientRect(); // visual drop position (includes the drag transform)
    if (opts.mode === "free") {
      const { left, top } = freePlacement(box(r.left, r.top, r.width, r.height), vp);
      writeOffset(0, 0);
      setAnchors("left", "top", left, top, r.width, r.height, vp);
      return;
    }
    const prevEdge = el.dataset.edge as PaneEdge | undefined;
    const placement = chooseEdge(box(r.left, r.top, r.width, r.height), vp, prevEdge);
    writeOffset(0, 0);
    apply(placement, r.width, r.height, vp);
    if (placement.edge !== prevEdge) {
      el.dataset.edge = placement.edge;
      opts.onEdgeChange?.(placement.edge);
    }
  };

  // Re-dock flush to the current edge (after a resize or a size change), then re-clear chrome.
  const reflow = (): void => {
    const hasInline =
      el.style.left !== "" ||
      el.style.right !== "" ||
      el.style.top !== "" ||
      el.style.bottom !== "";
    if (!hasInline) return;
    const vp = viewport();
    const r = el.getBoundingClientRect();
    if (opts.mode === "free") {
      const { left, top } = freePlacement(box(r.left, r.top, r.width, r.height), vp);
      setAnchors("left", "top", left, top, r.width, r.height, vp);
      return;
    }
    const edge = (el.dataset.edge as PaneEdge | undefined) ?? "bottom";
    let left = r.left;
    let top = r.top;
    if (edge === "left") left = EDGE_GAP_PX;
    if (edge === "right") left = vp.width - r.width - EDGE_GAP_PX;
    if (edge === "top") top = EDGE_GAP_PX;
    if (edge === "bottom") top = vp.height - r.height - EDGE_GAP_PX;
    left = clamp(
      left,
      VIEWPORT_MARGIN_PX,
      Math.max(VIEWPORT_MARGIN_PX, vp.width - r.width - VIEWPORT_MARGIN_PX),
    );
    top = clamp(
      top,
      VIEWPORT_MARGIN_PX,
      Math.max(VIEWPORT_MARGIN_PX, vp.height - r.height - VIEWPORT_MARGIN_PX),
    );
    // Anchor the free axis to the nearer side (by the re-docked center) so the strip tracks that
    // edge on the next resize instead of drifting from a stale fixed offset.
    let h: "left" | "right";
    let v: "top" | "bottom";
    if (edge === "left" || edge === "right") {
      h = edge;
      v = top + r.height / 2 > vp.height / 2 ? "bottom" : "top";
    } else {
      h = left + r.width / 2 > vp.width / 2 ? "right" : "left";
      v = edge;
    }
    apply({ edge, h, v, left, top }, r.width, r.height, vp);
  };

  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    const target = e.target as Element | null;
    if (target?.closest("button, input, select, textarea, a, [data-no-drag]")) return;
    startX = e.clientX;
    startY = e.clientY;
    baseX = readVar("--drag-x");
    baseY = readVar("--drag-y");
    pointerId = e.pointerId;
    handle.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!active && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!active) {
      active = true;
      el.classList.add("is-dragging");
    }
    writeOffset(baseX + dx, baseY + dy);
  };

  const onUp = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    handle.releasePointerCapture?.(e.pointerId);
    pointerId = null;
    if (!active) return;
    active = false;
    el.classList.remove("is-dragging");
    snap();
    recentlyDragged = true; // suppress the trailing click; a microtask is too early
    view?.setTimeout(() => {
      recentlyDragged = false;
    }, 0);
  };

  const onClick = (e: MouseEvent): void => {
    if (!recentlyDragged) return;
    e.preventDefault();
    e.stopPropagation();
    recentlyDragged = false;
  };

  handle.addEventListener("pointerdown", onDown, { signal });
  handle.addEventListener("pointermove", onMove, { signal });
  handle.addEventListener("pointerup", onUp, { signal });
  handle.addEventListener("pointercancel", onUp, { signal });
  el.addEventListener("click", onClick, { capture: true, signal });

  let resizeScheduled = false;
  view?.addEventListener(
    "resize",
    () => {
      if (resizeScheduled) return;
      resizeScheduled = true;
      view.requestAnimationFrame(() => {
        resizeScheduled = false;
        reflow();
      });
    },
    { signal },
  );

  return {
    reflow,
    wasDragging: () => recentlyDragged,
    dispose() {
      ac.abort();
    },
  };
}
