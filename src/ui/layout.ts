import { clamp } from "@schema/math.ts";

// Chrome layout primitives shared across the floating + rail subsystems. These live in TS (not as
// CSS custom properties) because they feed JS geometry math — gesture-activation slop, viewport
// keep-in clamping, and anchor→popover offsets — not the cascade. Subsystem-specific spacings (edge
// insets, inter-element group/corner gaps, snap distances) stay local to the module that owns that
// geometry, even when they happen to share a pixel value.

export const GESTURE_THRESHOLD_PX = 4; // pointer travel before a drag/resize gesture commits
export const VIEWPORT_MARGIN_PX = 8; // keep at least this much of a floating element on-screen
export const POPOVER_GAP_PX = 10; // offset between an anchor (rail tab, colorbar) and its popover

export function positionArrowFlyout(
  el: HTMLElement,
  leftEdge: DOMRect, // panel opens right of this
  tailAnchor: DOMRect, // arrow centers on this
  doc: Document,
): void {
  el.style.left = `${Math.round(leftEdge.right + POPOVER_GAP_PX)}px`;
  const arrowY = tailAnchor.top + tailAnchor.height / 2;
  const height = el.offsetHeight; // valid only while shown
  const viewportH = doc.documentElement.clientHeight;
  const top = clamp(
    arrowY - height / 2,
    VIEWPORT_MARGIN_PX,
    viewportH - height - VIEWPORT_MARGIN_PX,
  );
  el.style.top = `${Math.round(top)}px`;
  el.style.setProperty("--arrow-pos", `${Math.round(arrowY - top)}px`);
}
