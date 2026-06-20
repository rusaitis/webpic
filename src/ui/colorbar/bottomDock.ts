import type { Box } from "../floating/dragSnap.ts";

// Co-centering of the bottom button rail and a bottom-docked colorbar (magviz's installColorbarDock,
// distilled to pure geometry). When the colorbar docks at the bottom edge *near* the centered rail
// the two lay out as one centered group: the rail's cluster slides aside (a translateX the caller
// applies) to make room and the colorbar sits flush beside it with GROUP_GAP_PX between. Drop the
// colorbar far along the bottom — or to another edge — and it floats: the rail re-centers alone
// (railShift 0) and the colorbar stays where the dock placed it.
//
// Every offset is derived from the rail's *natural* centered position (the viewport center), never
// from its currently-shifted rect, so applying the returned railShift as an absolute transform is
// idempotent — re-running on resize/collapse never double-shifts. Pure — unit-tested; the caller
// measures the DOM (cluster width, corner widget) and applies the result.

export const GROUP_GAP_PX = 12; // gap between the rail cluster and the colorbar when grouped
const DOCK_PROXIMITY_PX = 72; // max gap from the natural cluster band for a bottom drop to group
const CORNER_GAP_PX = 12; // clearance kept right of the lower-left corner widget (gnomon/perf)
const VIEWPORT_MARGIN_PX = 8;

export interface BottomDockInput {
  /** The colorbar's settled rect: its width drives the group, its center picks the side + proximity. */
  readonly colorbar: Box;
  /** Width of the rail's button cluster (translate-invariant). 0 → nothing to group with. */
  readonly clusterWidth: number;
  readonly viewportWidth: number;
  /** Right edge (viewport px) of the lower-left corner widget the cluster must clear; 0 if none. */
  readonly cornerClearRight: number;
}

export interface BottomDockResult {
  /** translateX for the rail cluster off its natural center (0 = centered alone). */
  readonly railShift: number;
  /** Left for the colorbar when grouped; null → leave it where the dock placed it. */
  readonly colorbarLeft: number | null;
  readonly grouped: boolean;
  readonly side: "left" | "right";
}

/** Resolve the rail-shift + colorbar-left that center [cluster | gap | colorbar] (or the mirror) as
 *  one group, or signal "floating" (rail centered alone) when the colorbar dropped clear of the rail. */
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
  const grouped = cluster > 0 && gap < DOCK_PROXIMITY_PX;
  if (!grouped) return { railShift: 0, colorbarLeft: null, grouped: false, side };

  const total = cluster + GROUP_GAP_PX + colorbar.width;
  const minLeft = cornerClearRight > 0 ? cornerClearRight + CORNER_GAP_PX : VIEWPORT_MARGIN_PX;
  const maxLeft = Math.max(minLeft, vw - VIEWPORT_MARGIN_PX - total);
  const groupLeft = Math.min(Math.max((vw - total) / 2, minLeft), maxLeft);

  if (side === "right") {
    // [cluster | gap | colorbar]: the cluster leads, the colorbar trails to its right.
    return {
      railShift: groupLeft - naturalClusterLeft,
      colorbarLeft: groupLeft + cluster + GROUP_GAP_PX,
      grouped: true,
      side,
    };
  }
  // [colorbar | gap | cluster]: the colorbar leads, the cluster trails to its right.
  const clusterLeft = groupLeft + colorbar.width + GROUP_GAP_PX;
  return {
    railShift: clusterLeft - naturalClusterLeft,
    colorbarLeft: groupLeft,
    grouped: true,
    side,
  };
}
