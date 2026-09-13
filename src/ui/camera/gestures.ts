import { dollyDeltaForScale, rollPose, type SimulationStore } from "@store";
import type { Disposer } from "../controls/index.ts";
import { installCanvasCursor } from "./canvasCursor.ts";
import { dollyAtPoint } from "./dolly.ts";
import { installFocusGesture } from "./focusGesture.ts";
import { createTapRecognizer, createTwistGate, pinchDelta } from "./gestureRecognizers.ts";
import type { CameraGlide } from "./glide.ts";
import { installWheelDolly } from "./wheelDolly.ts";

// Pointer/wheel/touch input on the main-thread canvas → camera-pose intents. The OffscreenCanvas is
// transferred to the worker, but the <canvas> still receives DOM events here: read the live pose from
// the store, nudge it via the pure helpers (store/interaction/camera), dispatch setCameraPose. Damped motions
// (drag orbit/pan, two-finger pan) ride the glide's momentum; immediate ones (wheel / pinch dolly,
// twist roll) write the pose directly. Deltas normalize to viewport-height fractions — OrbitControls'
// unit, so the feel is identical at any canvas size. No render import — ui → store only.

// Drag normalization fallback when the canvas has no layout yet (happy-dom tests, hidden mounts).
const NOMINAL_VIEWPORT_PX = 800;

interface TrackedPointer {
  x: number; // live position, mutated per move
  y: number;
  readonly downX: number; // press origin/time, read only for tap detection
  readonly downY: number;
  readonly downAtMs: number;
}

export function installCameraGestures(
  target: HTMLElement,
  store: SimulationStore,
  glide: CameraGlide,
): Disposer {
  const abortController = new AbortController();
  const { signal } = abortController;
  const pointers = new Map<number, TrackedPointer>(); // one drags; two pinch
  let isPanning = false;
  let viewportHeight = NOMINAL_VIEWPORT_PX; // measured per gesture; drags normalize px by this
  // getBoundingClientRect forces layout, so it is measured once per gesture (pinch NDC) rather than
  // per event; the canvas can't resize mid-gesture.
  let gestureRect: DOMRect | undefined;
  // A pinch anywhere in the gesture disqualifies every release in it from being a tap.
  let wasMultiTouch = false;
  const taps = createTapRecognizer();
  const twist = createTwistGate();

  const cursor = installCanvasCursor(target, store, () => pointers.size > 0);

  const { triggerFocus } = installFocusGesture(target, store, glide, signal);

  // A primary pointer means no others are physically down, so anything still tracked is a phantom
  // from a multitouch release the browser never delivered (iOS/Android drop these mid-pinch), which
  // would otherwise lock the gesture at size >= 2 forever.
  const purgePhantoms = (): void => {
    for (const id of pointers.keys()) target.releasePointerCapture?.(id);
    pointers.clear();
    glide.dropMomentum(); // drop the phantom's fling so the new gesture starts clean
    wasMultiTouch = false;
  };

  // First finger down: measure once (getBoundingClientRect forces layout) and decide orbit vs pan.
  const beginGesture = (event: PointerEvent): void => {
    isPanning = event.shiftKey || event.button === 1 || event.button === 2;
    gestureRect = target.getBoundingClientRect();
    viewportHeight = gestureRect.height > 0 ? gestureRect.height : NOMINAL_VIEWPORT_PX;
    wasMultiTouch = false;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    if (event.isPrimary && pointers.size > 0) purgePhantoms();
    if (pointers.has(event.pointerId)) return; // button chord mid-drag — keep the current gesture
    if (pointers.size >= 2) return; // two fingers own the gesture; a third joins nothing
    if (event.button === 1) event.preventDefault(); // no middle-click autoscroll
    if (pointers.size === 0) beginGesture(event);
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      downX: event.clientX,
      downY: event.clientY,
      downAtMs: performance.now(),
    });
    if (pointers.size === 2) {
      wasMultiTouch = true; // a pinch began — no release in it is a tap
      twist.reset(); // fresh intent gate for this two-finger gesture
    }
    target.setPointerCapture?.(event.pointerId); // keep the drag if the cursor leaves the canvas
    cursor.apply();
    glide.setPointerDown(true);
  };

  // Two-pointer pinch: dolly by the spread ratio about the centroid (immediate, like wheel), pan by
  // the centroid translation (damped, like a drag), and roll by the finger-pair twist (immediate,
  // once it out-votes the zoom). All three compose — an RTS-style zoom/pan/rotate in one gesture.
  const onPinchMove = (event: PointerEvent, moved: TrackedPointer): void => {
    let other: TrackedPointer | undefined;
    for (const [id, p] of pointers) {
      if (id !== event.pointerId) other = p;
    }
    if (other === undefined) return;
    const to = { x: event.clientX, y: event.clientY };
    const delta = pinchDelta(moved, to, other);
    moved.x = to.x;
    moved.y = to.y;

    if (delta.panX !== 0 || delta.panY !== 0) {
      glide.pan(delta.panX / viewportHeight, delta.panY / viewportHeight);
    }
    if (delta.spreadDelta !== 0 && delta.scale !== 1) {
      const rect = gestureRect ?? target.getBoundingClientRect();
      dollyAtPoint(store, dollyDeltaForScale(delta.scale), delta.cx, delta.cy, rect);
    }
    if (delta.twist !== 0 && twist.advance(delta.twist, delta.spread, delta.spreadDelta)) {
      // Screen y is down, so a clockwise on-screen twist increases atan2; +roll banks the camera CW
      // (the world then reads CCW), so flip the sign to make the world follow the fingers.
      const { cameraPose, setCameraPose } = store.getState();
      setCameraPose(rollPose(cameraPose, -delta.twist));
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    const tracked = pointers.get(event.pointerId);
    if (tracked === undefined) return;
    if (pointers.size === 2) {
      onPinchMove(event, tracked);
      return;
    }
    const dx = event.clientX - tracked.x;
    const dy = event.clientY - tracked.y;
    tracked.x = event.clientX;
    tracked.y = event.clientY;
    if (dx === 0 && dy === 0) return;
    if (isPanning) glide.pan(dx / viewportHeight, dy / viewportHeight);
    else glide.orbit(dx / viewportHeight, dy / viewportHeight);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    const tracked = pointers.get(event.pointerId);
    if (tracked === undefined) return;
    // A clean single-finger tap (touch/pen, never part of a pinch, near-stationary, quick) on a
    // genuine pointerup; two within the window focus like a desktop double-click. pointercancel /
    // lostpointercapture are interruptions, not taps — they break the chain.
    if (event.type === "pointerup") {
      // Mouse keeps the native dblclick, and a release with another finger still down is part of a
      // pinch — neither is a tap candidate, and both break any chain in progress.
      const isTouch = event.pointerType === "touch" || event.pointerType === "pen";
      const now = performance.now();
      if (!isTouch || pointers.size !== 1) taps.breakChain();
      else if (
        taps.isDoubleTap({
          x: event.clientX,
          y: event.clientY,
          atMs: now,
          heldMs: now - tracked.downAtMs,
          travelPx: Math.hypot(event.clientX - tracked.downX, event.clientY - tracked.downY),
          wasMultiTouch,
        })
      ) {
        triggerFocus(event.clientX, event.clientY);
      }
    } else {
      taps.breakChain(); // pointercancel / lost capture is an interruption, not a tap
    }
    pointers.delete(event.pointerId);
    target.releasePointerCapture?.(event.pointerId);
    cursor.apply();
    glide.setPointerDown(pointers.size > 0);
  };

  target.addEventListener("pointerdown", onPointerDown, { signal });
  target.addEventListener("pointermove", onPointerMove, { signal });
  target.addEventListener("pointerup", onPointerEnd, { signal });
  target.addEventListener("pointercancel", onPointerEnd, { signal });
  target.addEventListener("lostpointercapture", onPointerEnd, { signal });
  target.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
  installWheelDolly({ target, store, glide, signal, hasLivePointers: () => pointers.size > 0 });

  return () => {
    abortController.abort();
    cursor.dispose();
    for (const id of pointers.keys()) target.releasePointerCapture?.(id);
    pointers.clear();
  };
}
