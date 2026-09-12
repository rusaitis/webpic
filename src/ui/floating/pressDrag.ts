import { GESTURE_THRESHOLD_PX } from "../layout.ts";

// The press-drag gesture shared by the floating chrome's drag (dragSnap) and resize (cornerResize):
// primary pointer only, pointer capture on the handle so the gesture survives leaving it, a movement
// threshold below which the press stays a click, and an `is-*` class on the moved element for the
// duration. Only the response to (dx, dy) differs between the two, so only that is injected.

export interface PressDragOptions {
  // The grab target — it takes pointer capture and the listeners. Often the element itself.
  readonly handle: HTMLElement;
  // The element the gesture moves or resizes; carries `activeClass` while the gesture is live.
  readonly element: HTMLElement;
  readonly activeClass: string;
  readonly signal: AbortSignal;
  // Called on a primary pointerdown, before the threshold. Return false to decline the press — the
  // gesture never arms and the event is left to whatever else is listening.
  readonly onStart?: (event: PointerEvent) => boolean | undefined;
  // Called once the threshold is crossed and on every move after; (dx, dy) are from the press point.
  readonly onMove: (dx: number, dy: number) => void;
  // Called on release, only if the gesture actually armed — a sub-threshold tap ends silently.
  readonly onEnd?: () => void;
}

export function installPressDrag(options: PressDragOptions): void {
  const { handle, element, activeClass, signal } = options;
  let startX = 0;
  let startY = 0;
  let pointerId: number | null = null;
  let isArmed = false;

  const onDown = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    if (options.onStart?.(event) === false) return;
    startX = event.clientX;
    startY = event.clientY;
    pointerId = event.pointerId;
    handle.setPointerCapture?.(event.pointerId);
  };

  const onMove = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!isArmed && Math.hypot(dx, dy) < GESTURE_THRESHOLD_PX) return;
    if (!isArmed) {
      isArmed = true;
      element.classList.add(activeClass);
    }
    options.onMove(dx, dy);
  };

  const onUp = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    handle.releasePointerCapture?.(event.pointerId);
    pointerId = null;
    if (!isArmed) return;
    isArmed = false;
    element.classList.remove(activeClass);
    options.onEnd?.();
  };

  handle.addEventListener("pointerdown", onDown, { signal });
  handle.addEventListener("pointermove", onMove, { signal });
  handle.addEventListener("pointerup", onUp, { signal });
  handle.addEventListener("pointercancel", onUp, { signal });
}
