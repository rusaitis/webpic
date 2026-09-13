import { dollyDeltaForScale, normalizeWheelDelta, type SimulationStore } from "@store";
import { dollyAtPoint } from "./dolly.ts";
import type { CameraGlide } from "./glide.ts";

// Wheel notches and Safari's proprietary trackpad-pinch GestureEvents, both feeding pixel-unit
// deltas into the one dolly-at-cursor path. Safari never delivers a trackpad pinch as ctrl+wheel, so
// the two cannot double-fire — but iPadOS Safari fires GestureEvents *and* pointer events for a
// two-finger touch pinch, so the bridge stands down while pointers are live and the pinch handler
// owns the gesture (else every pinch dollies twice).

interface WheelDollyHost {
  readonly target: HTMLElement;
  readonly store: SimulationStore;
  readonly glide: CameraGlide;
  readonly signal: AbortSignal;
  // True while the pointer path owns a gesture.
  readonly hasLivePointers: () => boolean;
}

export function installWheelDolly(host: WheelDollyHost): void {
  const { target, store, glide, signal } = host;
  // getBoundingClientRect forces layout, so it is measured once per wheel trail rather than per
  // notch; the canvas cannot resize mid-trail.
  let wheelRect: DOMRect | undefined;

  const dollyAt = (deltaY: number, clientX: number, clientY: number): void => {
    if (wheelRect === undefined || !glide.isWheelLive()) wheelRect = target.getBoundingClientRect();
    dollyAtPoint(store, deltaY, clientX, clientY, wheelRect);
    glide.touchWheel();
  };

  target.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault(); // we own the gesture — don't let the page scroll
      dollyAt(
        normalizeWheelDelta(event.deltaY, event.deltaMode, event.ctrlKey),
        event.clientX,
        event.clientY,
      );
    },
    // Non-passive: preventDefault needs an explicitly non-passive listener (wheel defaults passive).
    { passive: false, signal },
  );

  if (!("GestureEvent" in (target.ownerDocument.defaultView ?? {}))) return;

  let gestureScale = 1;
  target.addEventListener(
    "gesturestart",
    (event: Event) => {
      event.preventDefault();
      if (host.hasLivePointers()) return;
      gestureScale = 1;
    },
    { passive: false, signal },
  );
  target.addEventListener(
    "gesturechange",
    (event: Event) => {
      event.preventDefault();
      if (host.hasLivePointers()) return;
      // Safari-proprietary fields, absent from lib.dom — the feature gate below guards the cast.
      const gesture = event as Event & { scale: number; clientX: number; clientY: number };
      if (!(gesture.scale > 0)) return;
      dollyAt(dollyDeltaForScale(gestureScale / gesture.scale), gesture.clientX, gesture.clientY);
      gestureScale = gesture.scale;
    },
    { passive: false, signal },
  );
  target.addEventListener("gestureend", (event: Event) => event.preventDefault(), {
    passive: false,
    signal,
  });
}
