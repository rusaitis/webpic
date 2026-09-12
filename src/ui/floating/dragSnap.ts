import { clamp } from "@schema/math.ts";
import { GESTURE_THRESHOLD_PX, VIEWPORT_MARGIN_PX } from "../layout.ts";

// Pointer-driven drag + magnetic edge/corner snap for a single floating element (the colorbar).
// Movement during a drag rides CSS custom properties --drag-x / --drag-y consumed by a
// `transform: translate(...)` in the stylesheet; on release the element snaps flush to the nearest
// viewport edge (within EDGE_SNAP_PX) via inline left/right/top/bottom anchors, sets `data-edge`
// so the CSS reorients (left/right → vertical, top/bottom → horizontal), and springs clear of any
// registered chrome (the rails, top bar, docked shell) — so it attaches to an edge without ever
// covering the centered camera rail. A webpic-clean rewrite of magviz's draggablePanels (pure
// geometry split out for tests; AbortController-scoped listeners; no module-global stacking).

export type PaneEdge = "left" | "right" | "top" | "bottom";

// A key per literal, so widening PaneEdge without extending the guard is a type error.
const PANE_EDGES: Readonly<Record<PaneEdge, true>> = {
  left: true,
  right: true,
  top: true,
  bottom: true,
};

function isPaneEdge(value: string): value is PaneEdge {
  return Object.hasOwn(PANE_EDGES, value);
}

/** The dock edge held in `data-edge` — written here on snap, seeded by the owner — or undefined when
 *  unset. Validated against the literal set, so every reader gets a typed edge without a cast. */
export function readEdge(element: HTMLElement): PaneEdge | undefined {
  const edge = element.dataset.edge;
  return edge !== undefined && isPaneEdge(edge) ? edge : undefined;
}

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
  /** True when flush against an edge/corner; false for a free drop kept where released (the `edge`
   *  is then only an orientation hint). A floating element is not re-flushed on reflow, so a
   *  collapse/expand resizes it in place instead of migrating it to the edge. */
  readonly isDocked: boolean;
}

const FREE_DRAG_KEEP_PX = 64; // free panels may overhang an edge, but keep at least this much (a grab strip) on screen
const EDGE_SNAP_PX = 72; // dock to an edge when this close
const CORNER_SNAP_PX = 80; // pin both axes when this close to a corner
const EDGE_GAP_PX = 12; // breathing room from the edge when docked (matches the rail's bottom inset)
const CHROME_GAP_PX = 16; // clearance sprung between the strip and chrome (roomier than the edge inset)
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
      isDocked: true,
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
      isDocked: true,
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
      isDocked: true,
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
    isDocked: false, // a free drop in the middle: kept where released, edge is orientation-only
  };
}

/** Free-drag placement: a panel may overhang the left/right/bottom edges so it can be tucked aside,
 *  but FREE_DRAG_KEEP_PX of it (a grab strip) always stays on screen, and its top never crosses the
 *  top edge — the header is the only drag handle, so it must stay reachable. Pure — unit-tested. */
export function freePlacement(rect: Box, vp: Viewport): { left: number; top: number } {
  const keepX = Math.min(FREE_DRAG_KEEP_PX, rect.width);
  const keepY = Math.min(FREE_DRAG_KEEP_PX, rect.height);
  return {
    left: clamp(rect.left, keepX - rect.width, Math.max(keepX - rect.width, vp.width - keepX)),
    top: clamp(rect.top, VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, vp.height - keepY)),
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

/** Single-axis pushes that clear `r` from `o` with CHROME_GAP_PX of room. When docked to an edge,
 *  only the axis *along* the dock is offered — a bottom-docked strip springs sideways, never off
 *  the screen. Free elements get all four and the smallest wins. */
function pushVectors(
  r: Box,
  o: Box,
  edge: PaneEdge | undefined,
): ReadonlyArray<{ dx: number; dy: number }> {
  const horiz = [
    { dx: o.right - r.left + CHROME_GAP_PX, dy: 0 },
    { dx: o.left - r.right - CHROME_GAP_PX, dy: 0 },
  ];
  const vert = [
    { dx: 0, dy: o.bottom - r.top + CHROME_GAP_PX },
    { dx: 0, dy: o.top - r.bottom - CHROME_GAP_PX },
  ];
  if (edge === "top" || edge === "bottom") return horiz;
  if (edge === "left" || edge === "right") return vert;
  return [...horiz, ...vert];
}

/** Spring `rect`'s top-left out of every obstacle by the minimum-translation axis, staying inside
 *  the viewport, and return the *least-overlapping reachable* position. Greedy push that keeps the
 *  best position seen (fewest overlaps, then least displacement) and stops on a revisited position;
 *  if the greedy still overlaps (it stalls on a wide obstacle flanked by narrow ones), a fallback
 *  jumps past the union of the dock-band obstacles to the nearer clear side. A genuinely cramped
 *  edge with no clear slot settles deterministically instead of oscillating. Pure — unit-tested. */
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

  // The greedy stalls on a wide obstacle flanked by narrow ones: small pushes past the neighbours
  // oscillate instead of committing to the larger push that clears the wide one (e.g. the coords
  // chip between the rail's icon buttons). If still overlapping, jump just past the union of the
  // obstacles sharing the dock band to the nearer side that lands fully clear.
  if (bestOverlaps > 0) {
    const tryPlace = (left: number, top: number): void => {
      const cand = box(
        clamp(left, VIEWPORT_MARGIN_PX, maxLeft),
        clamp(top, VIEWPORT_MARGIN_PX, maxTop),
        rect.width,
        rect.height,
      );
      const oc = overlapCount(cand);
      if (oc < bestOverlaps) {
        best = cand;
        bestOverlaps = oc;
      }
    };
    if (edge !== "left" && edge !== "right") {
      const band = obstacles.filter((o) => o.top < rect.bottom && o.bottom > rect.top);
      if (band.length > 0) {
        const lo = Math.min(...band.map((o) => o.left));
        const hi = Math.max(...band.map((o) => o.right));
        const rightFirst = rect.left + rect.width / 2 >= (lo + hi) / 2;
        tryPlace(rightFirst ? hi + CHROME_GAP_PX : lo - rect.width - CHROME_GAP_PX, rect.top);
        if (bestOverlaps > 0) {
          tryPlace(rightFirst ? lo - rect.width - CHROME_GAP_PX : hi + CHROME_GAP_PX, rect.top);
        }
      }
    }
    if (bestOverlaps > 0 && edge !== "top" && edge !== "bottom") {
      const band = obstacles.filter((o) => o.left < rect.right && o.right > rect.left);
      if (band.length > 0) {
        const lo = Math.min(...band.map((o) => o.top));
        const hi = Math.max(...band.map((o) => o.bottom));
        const downFirst = rect.top + rect.height / 2 >= (lo + hi) / 2;
        tryPlace(rect.left, downFirst ? hi + CHROME_GAP_PX : lo - rect.height - CHROME_GAP_PX);
        if (bestOverlaps > 0) {
          tryPlace(rect.left, downFirst ? lo - rect.height - CHROME_GAP_PX : hi + CHROME_GAP_PX);
        }
      }
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
  /** Anchor the *free* axis (the one not pinned to a dock edge) by its center rather than a corner,
   *  so a size change (collapse/expand) pivots on the center. The stylesheet must translate that axis
   *  by -50% (`translateX(-50%)` on top/bottom docks, `translateY(-50%)` on left/right, both for a
   *  free drop). The colorbar options in; the free-mode window keeps corner anchoring. */
  readonly centerFreeAxis?: boolean;
  /** Fired when the dock edge changes (the colorbar repaints its gradient orientation). */
  readonly onEdgeChange?: (edge: PaneEdge) => void;
  /** Fired after every settle (drag release, reflow, resize) with the element's resolved edge + box,
   *  so a consumer can co-layout neighbouring chrome (the colorbar re-centers the bottom rail). It
   *  may write the element's own anchors; it must not resize tracked chrome (that would re-trigger). */
  readonly onSettled?: (edge: PaneEdge, settled: Box, vp: Viewport) => void;
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

export function installDragSnap(
  element: HTMLElement,
  options: DragSnapOptions = {},
): DragSnapController {
  const handle = options.handle ?? element;
  const doc = element.ownerDocument;
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
    // Legacy corner-anchor path (no center pivot): anchor the free axis to the nearer side so the
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

  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    const target = e.target as Element | null; // EventTarget → Element narrowing for closest()
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
    if (!active && Math.hypot(dx, dy) < GESTURE_THRESHOLD_PX) return;
    if (!active) {
      active = true;
      element.classList.add("is-dragging");
    }
    writeOffset(baseX + dx, baseY + dy);
  };

  const onUp = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    handle.releasePointerCapture?.(e.pointerId);
    pointerId = null;
    if (!active) return;
    active = false;
    element.classList.remove("is-dragging");
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
  element.addEventListener("click", onClick, { capture: true, signal });

  // Coalesce reflow triggers (window resize, chrome resize) to one per frame.
  let reflowScheduled = false;
  const scheduleReflow = (): void => {
    if (reflowScheduled || !view) return;
    reflowScheduled = true;
    view.requestAnimationFrame(() => {
      reflowScheduled = false;
      reflow();
    });
  };
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
      ac.abort();
    },
  };
}
