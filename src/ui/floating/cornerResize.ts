import { clamp } from "@schema/math.ts";
import type { Disposer } from "../controls/index.ts";
import { VIEWPORT_MARGIN_PX } from "../layout.ts";
import { installPressDrag } from "./pressDrag.ts";

// Pointer-driven resize from a corner handle for a floating element. Dragging the handle (the
// element's bottom-right grip) grows/shrinks width + height while the top-left stays put (the element
// is anchored top-left), so resizing never moves the window. The gesture itself is pressDrag's — the
// same one dragSnap uses — so only the dimension math lives here, as a pure helper for tests.

export interface ResizeBounds {
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

// New width/height after dragging the corner by (dx, dy) from a start size, clamped to bounds. The
// max is floored at the min so a too-small viewport can't invert the range. Pure — unit-tested.
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
  // Viewport breathing room kept past the element's far edge. Defaults to VIEWPORT_MARGIN_PX.
  readonly margin?: number;
  // Fired after each applied size change (e.g. to reflow content).
  readonly onResize?: () => void;
}

export function installCornerResize(
  element: HTMLElement,
  handle: HTMLElement,
  options: CornerResizeOptions = {},
): Disposer {
  const doc = element.ownerDocument;
  const ac = new AbortController();
  const { signal } = ac;
  const minWidth = options.minWidth ?? 160;
  const minHeight = options.minHeight ?? 120;
  const margin = options.margin ?? VIEWPORT_MARGIN_PX;

  let startWidth = 0;
  let startHeight = 0;
  let originLeft = 0; // element top-left at gesture start → bounds the far-edge clamp
  let originTop = 0;

  installPressDrag({
    handle,
    element,
    activeClass: "is-resizing",
    signal,
    onStart: () => {
      const rect = element.getBoundingClientRect();
      startWidth = rect.width;
      startHeight = rect.height;
      originLeft = rect.left;
      originTop = rect.top;
      return true;
    },
    onMove: (dx, dy) => {
      const { width, height } = resizeDims(startWidth, startHeight, dx, dy, {
        minWidth,
        minHeight,
        maxWidth: doc.documentElement.clientWidth - originLeft - margin,
        maxHeight: doc.documentElement.clientHeight - originTop - margin,
      });
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      options.onResize?.();
    },
  });

  return () => ac.abort();
}
