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
// A drop too far from any edge to dock still reorients `data-edge`, flipping across the viewport
// midline along the axis the element is already on — so the CSS tail/anchor points the right way.
function freeDropEdge(rect: Box, vp: Viewport, prevEdge: PaneEdge | undefined): PaneEdge {
  if (prevEdge === "top" || prevEdge === "bottom") {
    const cy = rect.top + rect.height / 2;
    return stickyLess(cy, vp.height - cy, prevEdge, "top", "bottom") ? "top" : "bottom";
  }
  const cx = rect.left + rect.width / 2;
  return stickyLess(cx, vp.width - cx, prevEdge, "left", "right") ? "left" : "right";
}

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

  const h = leftSide ? "left" : "right";
  const v = topSide ? "top" : "bottom";
  const dockedLeft = leftSide ? EDGE_GAP_PX : dockLeft;
  const dockedTop = topSide ? EDGE_GAP_PX : dockTop;
  const freeLeft = clamp(rect.left, VIEWPORT_MARGIN_PX, W - rect.width - VIEWPORT_MARGIN_PX);
  const freeTop = clamp(rect.top, VIEWPORT_MARGIN_PX, H - rect.height - VIEWPORT_MARGIN_PX);

  if (cornerNearH && cornerNearV) {
    // Orient along whichever axis gives the more natural strip (wider → horizontal).
    const edge: PaneEdge = rect.width >= rect.height ? v : h;
    return { edge, h, v, left: dockedLeft, top: dockedTop, isDocked: true };
  }
  // Anchor the free axis to whichever side the strip leans toward, so it tracks that edge on the
  // next resize (a bottom-right strip stays glued to the right corner instead of drifting left as
  // the centered rail re-centers) rather than always pinning the low edge.
  if (nearH) return { edge: h, h, v, left: dockedLeft, top: freeTop, isDocked: true };
  if (nearV) return { edge: v, h, v, left: freeLeft, top: dockedTop, isDocked: true };

  const edge = freeDropEdge(rect, vp, prevEdge);
  return {
    edge,
    h: edge === "right" ? "right" : "left",
    v: edge === "bottom" ? "bottom" : "top",
    left: freeLeft,
    top: freeTop,
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

// Where a docked element sits once re-flushed to its edge; a free drop keeps its visual position.
export function flushedToEdge(rect: Box, edge: PaneEdge, isDocked: boolean, vp: Viewport): Box {
  if (!isDocked) return rect;
  const left =
    edge === "left"
      ? EDGE_GAP_PX
      : edge === "right"
        ? vp.width - rect.width - EDGE_GAP_PX
        : rect.left;
  const top =
    edge === "top"
      ? EDGE_GAP_PX
      : edge === "bottom"
        ? vp.height - rect.height - EDGE_GAP_PX
        : rect.top;
  return box(left, top, rect.width, rect.height);
}

// Anchor the free axis to whichever side the element leans toward, so it tracks that edge on the
// next resize instead of drifting from a stale fixed offset.
export function leaningAnchors(
  edge: PaneEdge,
  rect: Box,
  vp: Viewport,
): { h: "left" | "right"; v: "top" | "bottom" } {
  return edge === "left" || edge === "right"
    ? { h: edge, v: rect.top + rect.height / 2 > vp.height / 2 ? "bottom" : "top" }
    : { h: rect.left + rect.width / 2 > vp.width / 2 ? "right" : "left", v: edge };
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

type Axis = "x" | "y";

// How far `rect` may travel and still sit inside the viewport.
interface Bounds {
  readonly maxLeft: number;
  readonly maxTop: number;
}

// A position and how many obstacles it still overlaps.
interface Settled {
  readonly at: Box;
  readonly overlaps: number;
}

// Greedy minimum-translation relaxation, iteration-capped and cycle-guarded. Keeps the best position
// seen — fewest overlaps, then least displacement from where the drag left it — so a cramped edge
// with no clear slot settles deterministically instead of oscillating.
function relaxOutOfOverlaps(
  rect: Box,
  obstacles: readonly Box[],
  edge: PaneEdge | undefined,
  bounds: Bounds,
  overlapCount: (b: Box) => number,
): Settled {
  let cur = rect;
  let best: Settled = { at: rect, overlaps: overlapCount(rect) };
  let bestDist = 0;
  const seen = new Set<string>();
  for (let iter = 0; iter < 12 && best.overlaps > 0; iter++) {
    const key = `${Math.round(cur.left)},${Math.round(cur.top)}`;
    if (seen.has(key)) break; // revisited → cycle, no further progress
    seen.add(key);

    const push = minimalPush(cur, obstacles, edge);
    if (push === null) break;
    cur = box(
      clamp(cur.left + push.dx, VIEWPORT_MARGIN_PX, bounds.maxLeft),
      clamp(cur.top + push.dy, VIEWPORT_MARGIN_PX, bounds.maxTop),
      rect.width,
      rect.height,
    );

    const overlaps = overlapCount(cur);
    const dist = Math.abs(cur.left - rect.left) + Math.abs(cur.top - rect.top);
    if (overlaps < best.overlaps || (overlaps === best.overlaps && dist < bestDist)) {
      best = { at: cur, overlaps };
      bestDist = dist;
    }
  }
  return best;
}

// The two positions that clear the union of the obstacles sharing `rect`'s band along `axis`, nearer
// side first. The x and y cases are the same five steps with the accessors swapped, so they are
// written once: which obstacles share the band, the union's extent, and the jump past either end.
function bandEscapes(rect: Box, obstacles: readonly Box[], axis: Axis): readonly Box[] {
  const isHorizontal = axis === "x";
  const band = obstacles.filter((o) =>
    isHorizontal
      ? o.top < rect.bottom && o.bottom > rect.top
      : o.left < rect.right && o.right > rect.left,
  );
  if (band.length === 0) return [];
  const lo = Math.min(...band.map((o) => (isHorizontal ? o.left : o.top)));
  const hi = Math.max(...band.map((o) => (isHorizontal ? o.right : o.bottom)));
  const extent = isHorizontal ? rect.width : rect.height;
  const leading = (isHorizontal ? rect.left : rect.top) + extent / 2 >= (lo + hi) / 2;
  const past = hi + CHROME_GAP_PX;
  const before = lo - extent - CHROME_GAP_PX;
  const at = (v: number): Box =>
    isHorizontal
      ? box(v, rect.top, rect.width, rect.height)
      : box(rect.left, v, rect.width, rect.height);
  return leading ? [at(past), at(before)] : [at(before), at(past)];
}

// Spring `rect`'s top-left out of every obstacle by the minimum-translation axis, staying inside the
// viewport, and return the least-overlapping reachable position. The greedy relaxation stalls on a
// wide obstacle flanked by narrow ones — small pushes past the neighbours oscillate instead of
// committing to the larger push that clears the wide one (the coords chip between the rail's icon
// buttons) — so a still-overlapping result then tries the band escapes along whichever axes the dock
// leaves free. Pure — unit-tested.
export function pushOutOf(
  rect: Box,
  obstacles: readonly Box[],
  edge: PaneEdge | undefined,
  vp: Viewport,
): { left: number; top: number } {
  const bounds: Bounds = {
    maxLeft: Math.max(VIEWPORT_MARGIN_PX, vp.width - VIEWPORT_MARGIN_PX - rect.width),
    maxTop: Math.max(VIEWPORT_MARGIN_PX, vp.height - VIEWPORT_MARGIN_PX - rect.height),
  };
  const overlapCount = (b: Box): number =>
    obstacles.reduce((n, o) => n + (overlaps(b, o) ? 1 : 0), 0);

  let best = relaxOutOfOverlaps(rect, obstacles, edge, bounds, overlapCount);

  // A dock pins one axis, so only the axis along it may escape; a free element may use both.
  const axes: readonly Axis[] = [
    ...(edge === "left" || edge === "right" ? [] : (["x"] as const)),
    ...(edge === "top" || edge === "bottom" ? [] : (["y"] as const)),
  ];
  for (const axis of axes) {
    for (const candidate of bandEscapes(rect, obstacles, axis)) {
      if (best.overlaps === 0) break;
      const at = box(
        clamp(candidate.left, VIEWPORT_MARGIN_PX, bounds.maxLeft),
        clamp(candidate.top, VIEWPORT_MARGIN_PX, bounds.maxTop),
        rect.width,
        rect.height,
      );
      const count = overlapCount(at);
      if (count < best.overlaps) best = { at, overlaps: count };
    }
  }
  return { left: best.at.left, top: best.at.top };
}
