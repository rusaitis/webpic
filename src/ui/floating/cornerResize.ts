import { clamp } from "@schema/math.ts";
import type { Disposer } from "../controls/index.ts";
import { GESTURE_THRESHOLD_PX, VIEWPORT_MARGIN_PX } from "../layout.ts";

// Pointer-driven resize from a corner handle for a floating element. Dragging the handle (the
// element's bottom-right grip) grows/shrinks width + height while the top-left stays put (the element
// is anchored top-left), so resizing never moves the window. AbortController-scoped listeners; the
// dimension math is a pure helper for tests. Same gesture conventions as dragSnap (4px threshold,
// pointer capture, no-op on sub-threshold taps).

export interface ResizeBounds {
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/** New width/height after dragging the corner by (dx, dy) from a start size, clamped to bounds. The
 *  max is floored at the min so a too-small viewport can't invert the range. Pure — unit-tested. */
export function resizeDims(
  startWidth: number,
  startHeight: number,
  dx: number,
  dy: number,
  bounds: ResizeBounds,
): { width: number; height: number } {
  return {
    width: clamp(startWidth + dx, bounds.minWidth, Math.max(bounds.minWidth, bounds.maxWidth)),
    height: clamp(startHeight + dy, bounds.minHeight, Math.max(bounds.minHeight, bounds.maxHeight)),
  };
}

export interface CornerResizeOptions {
  readonly minWidth?: number;
  readonly minHeight?: number;
  /** Viewport breathing room kept past the element's far edge. Defaults to VIEWPORT_MARGIN_PX. */
  readonly margin?: number;
  /** Fired after each applied size change (e.g. to reflow content). */
  readonly onResize?: () => void;
}

export function installCornerResize(
  el: HTMLElement,
  handle: HTMLElement,
  opts: CornerResizeOptions = {},
): Disposer {
  const doc = el.ownerDocument;
  const ac = new AbortController();
  const { signal } = ac;
  const minWidth = opts.minWidth ?? 160;
  const minHeight = opts.minHeight ?? 120;
  const margin = opts.margin ?? VIEWPORT_MARGIN_PX;

  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let originLeft = 0; // element top-left at gesture start → bounds the far-edge clamp
  let originTop = 0;
  let active = false;
  let pointerId: number | null = null;

  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    const rect = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startWidth = rect.width;
    startHeight = rect.height;
    originLeft = rect.left;
    originTop = rect.top;
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
      el.classList.add("is-resizing");
    }
    const { width, height } = resizeDims(startWidth, startHeight, dx, dy, {
      minWidth,
      minHeight,
      maxWidth: doc.documentElement.clientWidth - originLeft - margin,
      maxHeight: doc.documentElement.clientHeight - originTop - margin,
    });
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    opts.onResize?.();
  };

  const onUp = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    handle.releasePointerCapture?.(e.pointerId);
    pointerId = null;
    if (!active) return;
    active = false;
    el.classList.remove("is-resizing");
  };

  handle.addEventListener("pointerdown", onDown, { signal });
  handle.addEventListener("pointermove", onMove, { signal });
  handle.addEventListener("pointerup", onUp, { signal });
  handle.addEventListener("pointercancel", onUp, { signal });

  return () => ac.abort();
}
