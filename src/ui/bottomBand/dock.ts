import { clamp } from "@schema/math.ts";
import type { Box } from "../floating/dragSnap.ts";
import { VIEWPORT_MARGIN_PX } from "../layout.ts";

// Co-centering of the bottom button rail and a bottom-docked colorbar, as pure geometry. Docked at the
// bottom edge *near* the centered rail, the two lay out as one centered group: the rail's cluster
// slides aside (a translateX the caller applies) and the colorbar sits flush beside it. Dropped far
// along the bottom — or on another edge — both float free. Every offset derives from the rail's
// *natural* centered position, never its currently-shifted rect, so applying railShift as an absolute
// transform is idempotent: re-running on resize or collapse never double-shifts.

export const GROUP_GAP_PX = 12; // gap between the rail cluster and the colorbar when grouped
const DOCK_PROXIMITY_PX = 72; // max gap from the natural cluster band for a bottom drop to group
const CORNER_GAP_PX = 12; // clearance kept right of the lower-left corner widget (gnomon/perf)
// The bottom-left gnomon's reserved footprint (12px inset + 56px triad + 12px) — mirrors the rail's
// `has-gnomon` padding. The centered cluster needs this much clear on each side to not slide under it.
const GNOMON_RESERVE_PX = 80;
const GNOMON_CRAMP_HYSTERESIS_PX = 24; // extra width required to *restore* the gnomon (anti-flicker)

export interface BottomDockInput {
  // The colorbar's settled rect: its width drives the group, its center picks the side + proximity.
  readonly colorbar: Box;
  // Width of the rail's button cluster (translate-invariant). 0 → nothing to group with.
  readonly clusterWidth: number;
  readonly viewportWidth: number;
  // Right edge (viewport px) of the lower-left corner widget the cluster must clear; 0 if none.
  readonly cornerClearRight: number;
}

export interface BottomDockResult {
  // translateX for the rail cluster off its natural center (0 = centered alone).
  readonly railShift: number;
  // Left for the colorbar when grouped; null → leave it where the dock placed it.
  readonly colorbarLeft: number | null;
  readonly isGrouped: boolean;
  readonly side: "left" | "right";
}

// Resolve the rail-shift + colorbar-left that center [cluster | gap | colorbar] (or the mirror) as
// one group, or signal "floating" (rail centered alone) when the colorbar dropped clear of the rail.
export function bottomDockLayout(input: BottomDockInput): BottomDockResult {
  const { colorbar, clusterWidth: cluster, viewportWidth: vw, cornerClearRight } = input;
  const center = vw / 2;
  const colorbarCenter = colorbar.left + colorbar.width / 2;
  const side: "left" | "right" = colorbarCenter >= center ? "right" : "left";

  const naturalClusterLeft = (vw - cluster) / 2;
  const naturalClusterRight = (vw + cluster) / 2;
  // Gap from the colorbar to the rail's natural (centered) cluster band; negative = overlapping it.
  const gap =
    side === "right" ? colorbar.left - naturalClusterRight : naturalClusterLeft - colorbar.right;
  const isGrouped = cluster > 0 && gap < DOCK_PROXIMITY_PX;
  if (!isGrouped) return { railShift: 0, colorbarLeft: null, isGrouped: false, side };

  const total = cluster + GROUP_GAP_PX + colorbar.width;
  const minLeft = cornerClearRight > 0 ? cornerClearRight + CORNER_GAP_PX : VIEWPORT_MARGIN_PX;
  const maxLeft = Math.max(minLeft, vw - VIEWPORT_MARGIN_PX - total);
  const groupLeft = clamp((vw - total) / 2, minLeft, maxLeft);

  if (side === "right") {
    // [cluster | gap | colorbar]: the cluster leads, the colorbar trails to its right.
    return {
      railShift: groupLeft - naturalClusterLeft,
      colorbarLeft: groupLeft + cluster + GROUP_GAP_PX,
      isGrouped: true,
      side,
    };
  }
  // [colorbar | gap | cluster]: the colorbar leads, the cluster trails to its right.
  const clusterLeft = groupLeft + colorbar.width + GROUP_GAP_PX;
  return {
    railShift: clusterLeft - naturalClusterLeft,
    colorbarLeft: groupLeft,
    isGrouped: true,
    side,
  };
}

// Responsive fit of the bottom-docked colorbar beside the centered rail. As the viewport narrows the
// strip first minimizes (collapsed is far shorter), then — when even collapsed can't sit beside the
// cluster — migrates up a side edge (vertical) to clear the rail entirely. Pure + predictive: the
// caller supplies both rendered widths (cached at settle time) so the decision never reads a strip
// mid-collapse-transition and so it's monotonic in viewport width (no expand↔collapse oscillation).
export type ColorbarFitMode = "expanded" | "collapsed" | "migrate";

export interface ColorbarFitInput {
  readonly viewportWidth: number;
  // Rail button-cluster width; 0 → no rail to group with, so the strip always stays expanded.
  readonly clusterWidth: number;
  // Right edge (px) of the lower-left corner widget the group must clear; 0 if none/suppressed.
  readonly cornerClearRight: number;
  readonly expandedWidth: number;
  readonly collapsedWidth: number;
}

// Widest mode whose [cluster | gap | strip] group still fits between the corner widget and the
// right margin; "migrate" when not even the collapsed strip does.
export function colorbarFitMode(input: ColorbarFitInput): ColorbarFitMode {
  const {
    viewportWidth: vw,
    clusterWidth,
    cornerClearRight,
    expandedWidth,
    collapsedWidth,
  } = input;
  if (clusterWidth <= 0) return "expanded"; // nothing to compete with on the bottom row
  const minLeft = cornerClearRight > 0 ? cornerClearRight + CORNER_GAP_PX : VIEWPORT_MARGIN_PX;
  const budget = vw - VIEWPORT_MARGIN_PX - minLeft; // max group width that fits flush right
  if (clusterWidth + GROUP_GAP_PX + expandedWidth <= budget) return "expanded";
  if (clusterWidth + GROUP_GAP_PX + collapsedWidth <= budget) return "collapsed";
  return "migrate";
}

// True when the centered rail cluster can't keep the gnomon's reserved corner clear on both sides,
// so the gnomon should be hidden. Hysteresis: once hidden, require extra width before restoring.
export function isRailGnomonCramped(
  viewportWidth: number,
  clusterWidth: number,
  isCurrentlySuppressed: boolean,
): boolean {
  if (clusterWidth <= 0) return false;
  const threshold = clusterWidth + 2 * GNOMON_RESERVE_PX;
  return viewportWidth < threshold + (isCurrentlySuppressed ? GNOMON_CRAMP_HYSTERESIS_PX : 0);
}
