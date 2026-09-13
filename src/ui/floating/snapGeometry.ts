import { clamp } from "@schema/math.ts";
import { VIEWPORT_MARGIN_PX } from "../layout.ts";

// Where a dragged floating element comes to rest: the magnetic edge/corner snap, the free-drop
// clamp, and the spring that pushes it clear of registered chrome. Pure geometry — boxes in,
// placements out, no element and no listeners — so each rule is unit-tested directly. dragSnap.ts
// is the installer that feeds it live rects and writes the result back to CSS.

export type PaneEdge = "left" | "right" | "top" | "bottom";

// A key per literal, so widening PaneEdge without extending the guard is a type error.
const PANE_EDGES: Readonly<Record<PaneEdge, true>> = {
  left: true,
  right: true,
  top: true,
  bottom: true,
};

export function isPaneEdge(value: string): value is PaneEdge {
  return Object.hasOwn(PANE_EDGES, value);
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

// Where a snap wants to place the element: which edge it docks to, the anchor side per axis
// (so expand/collapse grows toward the viewport center), and the resolved top-left.
export interface SnapPlacement {
  readonly edge: PaneEdge;
  readonly h: "left" | "right";
  readonly v: "top" | "bottom";
  readonly left: number;
  readonly top: number;
  // True when flush against an edge/corner; false for a free drop kept where released (the `edge`
  // is then only an orientation hint). A floating element is not re-flushed on reflow, so a
  // collapse/expand resizes it in place instead of migrating it to the edge.
  readonly isDocked: boolean;
}

const FREE_DRAG_KEEP_PX = 64; // free panels may overhang an edge, but keep at least this much (a grab strip) on screen
const EDGE_SNAP_PX = 72; // dock to an edge when this close
const CORNER_SNAP_PX = 80; // pin both axes when this close to a corner
export const EDGE_GAP_PX = 12; // breathing room from the edge when docked (matches the rail's bottom inset)
const CHROME_GAP_PX = 16; // clearance sprung between the strip and chrome (roomier than the edge inset)
const STICKY_HYSTERESIS_PX = 120; // bias toward the current edge so tall/wide strips don't oscillate
const OVERLAP_EPSILON_PX = 0.5; // sub-pixel snap residue is not a collision

export function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

// `a < b`, biased by STICKY_HYSTERESIS_PX toward the element's current edge so a strip whose two
// opposite-edge distances are both small doesn't flip-flop on tiny drags.
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

// Resolve where `rect` should dock given the viewport and its previous edge. Snaps to a corner
// (both axes) or a single edge when within threshold; otherwise a free drop that still reorients
// `data-edge` across the viewport midline along the current axis. Pure — unit-tested.
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

  // Which side of each axis the strip leans toward. Branch-invariant — every arm below returns the
  // same h/v from it, and stickyLess only reads distances and the previous edge.
  const leftSide = stickyLess(distL, distR, prevEdge, "left", "right");
  const topSide = stickyLess(distT, distB, prevEdge, "top", "bottom");

  if (cornerNearH && cornerNearV) {
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

// Free-drag placement: a panel may overhang the left/right/bottom edges so it can be tucked aside,
// but FREE_DRAG_KEEP_PX of it (a grab strip) always stays on screen, and its top never crosses the
// top edge — the header is the only drag handle, so it must stay reachable. Pure — unit-tested.
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

// Single-axis pushes that clear `r` from `o` with CHROME_GAP_PX of room. When docked to an edge,
// only the axis *along* the dock is offered — a bottom-docked strip springs sideways, never off
// the screen. Free elements get all four and the smallest wins.
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

// The shortest single-axis push that clears `rect` from any one obstacle it currently overlaps, or
// null when it overlaps none. Pushes are single-axis, so L1 and L2 magnitudes agree.
function minimalPush(
  rect: Box,
  obstacles: readonly Box[],
  edge: PaneEdge | undefined,
): { dx: number; dy: number } | null {
  let push: { dx: number; dy: number } | null = null;
  let magnitude = Number.POSITIVE_INFINITY;
  for (const obstacle of obstacles) {
    if (!overlaps(rect, obstacle)) continue;
    for (const vector of pushVectors(rect, obstacle, edge)) {
      const m = Math.abs(vector.dx) + Math.abs(vector.dy);
      if (m > 0 && m < magnitude) {
        magnitude = m;
        push = vector;
      }
    }
  }
  return push;
}

// Spring `rect`'s top-left out of every obstacle by the minimum-translation axis, staying inside
// the viewport, and return the *least-overlapping reachable* position. Greedy push that keeps the
// best position seen (fewest overlaps, then least displacement) and stops on a revisited position;
// if the greedy still overlaps (it stalls on a wide obstacle flanked by narrow ones), a fallback
// jumps past the union of the dock-band obstacles to the nearer clear side. A genuinely cramped
// edge with no clear slot settles deterministically instead of oscillating. Pure — unit-tested.
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

    const push = minimalPush(cur, obstacles, edge);
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
