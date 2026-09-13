import type { Box, PaneEdge, SnapPlacement, Viewport } from "./snapGeometry.ts";

// Writing a resolved placement onto an element as inline left/right/top/bottom. Two anchoring modes
// that a caller picks once: corner-anchored, and center-anchored on the free axis so a collapse or
// expand pivots on the center rather than dragging the element sideways (the stylesheet supplies the
// matching translate(-50%)). Pure DOM writes — no geometry decisions, no listeners.

export interface AnchorWriter {
  // Anchor `rect` per the placement's h/v (or its edge, under centerFreeAxis).
  write(placement: SnapPlacement, rect: Box, vp: Viewport): void;
  // The CSS-variable drag offset the stylesheet's transform consumes.
  offset(x: number, y: number): void;
}

export function createAnchorWriter(
  element: HTMLElement,
  shouldCenterFreeAxis: boolean,
): AnchorWriter {
  const style = element.style;
  const left = (v: number): void => {
    style.left = `${v}px`;
    style.right = "auto";
  };
  const right = (v: number): void => {
    style.right = `${v}px`;
    style.left = "auto";
  };
  const top = (v: number): void => {
    style.top = `${v}px`;
    style.bottom = "auto";
  };
  const bottom = (v: number): void => {
    style.bottom = `${v}px`;
    style.top = "auto";
  };

  const corners = (placement: SnapPlacement, rect: Box, vp: Viewport): void => {
    if (placement.h === "left") left(rect.left);
    else right(vp.width - rect.right);
    if (placement.v === "top") top(rect.top);
    else bottom(vp.height - rect.bottom);
  };

  // The visual top-left still resolves to (left, top); only the resize pivot changes. A free drop
  // centers both axes; a docked one centers the axis its edge leaves free.
  const centered = (edge: PaneEdge, isDocked: boolean, rect: Box, vp: Viewport): void => {
    const centerX = (): void => left(rect.left + rect.width / 2);
    const centerY = (): void => top(rect.top + rect.height / 2);
    if (!isDocked) {
      centerX();
      centerY();
      return;
    }
    if (edge === "top" || edge === "bottom") {
      centerX();
      if (edge === "bottom") bottom(vp.height - rect.bottom);
      else top(rect.top);
      return;
    }
    centerY();
    if (edge === "right") right(vp.width - rect.right);
    else left(rect.left);
  };

  return {
    write(placement, rect, vp) {
      if (shouldCenterFreeAxis) centered(placement.edge, placement.isDocked, rect, vp);
      else corners(placement, rect, vp);
    },
    offset(x, y) {
      style.setProperty("--drag-x", `${x}px`);
      style.setProperty("--drag-y", `${y}px`);
    },
  };
}
