import {
  cursorRay,
  DEFAULT_POSE,
  dollyDeltaForScale,
  dollyPose,
  dollyPoseToCursor,
  focusDistance,
  focusPoseOnPoint,
  normalizeWheelDelta,
  rollPose,
  type SimulationStore,
  unitBoxChordMidpoint,
} from "@store";
import type { CameraGlide } from "./cameraGlide.ts";
import type { Disposer } from "./controls/index.ts";
import { clientToNdc } from "./pointerMath.ts";
import { createSubscriptions } from "./subscriptions.ts";

// Pointer/wheel/touch input on the main-thread canvas → camera-pose intents. The OffscreenCanvas is
// transferred to the worker, but the <canvas> still receives DOM events here; we read the live pose
// from the store, nudge it via the pure helpers (store/camera), and dispatch setCameraPose. Damped
// motions (drag orbit/pan, two-finger pan) go through the glide's momentum; immediate ones (wheel /
// pinch dolly, twist roll) write the pose directly. No render import — ui → store only.
//
// Gestures (OrbitControls/magviz parity): left-drag orbits; shift/middle/right-drag pans (context
// menu suppressed); wheel dollies toward the cursor; two pointers pinch-dolly about their centroid,
// two-finger-pan, and twist-roll. Drag deltas are normalized to viewport-height fractions
// (OrbitControls' unit), so the feel is identical at any canvas size.

// Drag normalization fallback when the canvas has no layout yet (happy-dom tests, hidden mounts).
const NOMINAL_VIEWPORT_PX = 800;

// Touch/pen double-tap → pick-to-focus (mouse keeps the native dblclick). A "tap" is a short,
// near-stationary single-finger press; two within DBL_TAP_MS and DBL_TAP_SLOP_PX of each other
// focus like a desktop double-click. Standard mobile UX thresholds.
const TAP_SLOP_PX = 10; // a press that travels farther was a drag, not a tap
const TAP_MAX_MS = 500; // a press held longer was a press-and-hold, not a tap
const DBL_TAP_MS = 300; // two taps within this window pair into a double-tap
const DBL_TAP_SLOP_PX = 30; // ...and landing within this distance of each other

// Two-finger twist → camera roll. A pinch decomposes into radial (zoom) and tangential (twist)
// fingertip travel; roll engages only once the tangential travel clears a floor AND outweighs the
// radial — so a plain pinch-zoom, however wobbly, never banks, while a deliberate finger-orbit does.
// Past the gate the bank tracks the fingers 1:1 (direct manipulation). Reset per two-finger gesture.
const TWIST_ENGAGE_PX = 30; // tangential fingertip arc (px) before banking can engage
const TWIST_DOMINANCE = 1.5; // ...and the twist travel must outweigh the zoom travel by this factor

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
  const ac = new AbortController();
  const { signal } = ac;
  const pointers = new Map<number, TrackedPointer>(); // one drags; two pinch
  let panning = false;
  let viewportHeight = NOMINAL_VIEWPORT_PX; // measured per gesture; drags normalize px by this
  // getBoundingClientRect forces layout, so it's measured once per gesture (pinch NDC) and once
  // per wheel trail (dolly NDC) rather than per event; the canvas can't resize mid-gesture.
  let gestureRect: DOMRect | undefined;
  let wheelRect: DOMRect | undefined;
  // Touch double-tap state: a pinch (two fingers ever down this gesture) is never a tap; the last
  // tap's time/pos pairs the next one; lastFocusMs de-dupes a synthetic tap against a native dblclick.
  let wasMultiTouch = false;
  let lastTapMs = Number.NEGATIVE_INFINITY;
  let lastTapX = 0;
  let lastTapY = 0;
  let lastFocusMs = Number.NEGATIVE_INFINITY;
  // Two-finger twist→roll intent gate, per pinch gesture: accumulate tangential (twist) vs radial
  // (zoom) fingertip travel until the twist clearly wins, then bank 1:1. Reset when a second finger
  // lands (onPointerDown, size === 2).
  let twistTravelPx = 0;
  let zoomTravelPx = 0;
  let twistEngaged = false;

  // Single writer for the canvas cursor (the marker picker never sets it directly): a marker grab
  // or a camera drag reads "grabbing", a marker hover reads "pointer", everything else rests on "grab".
  // The picker reports its intent through the store (pickerActive/pickerHover), so the two never race.
  const applyCursor = (): void => {
    const { pickerActive, pickerHover } = store.getState();
    target.style.cursor =
      pickerActive || pointers.size > 0 ? "grabbing" : pickerHover !== "none" ? "pointer" : "grab";
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    // A primary pointer means no others are physically down: anything still tracked is a phantom
    // from a multitouch release the browser never delivered (iOS/Android drop these mid-pinch),
    // which would otherwise lock the gesture at size >= 2 forever. Purge before this one joins.
    if (event.isPrimary && pointers.size > 0) {
      for (const id of pointers.keys()) target.releasePointerCapture?.(id);
      pointers.clear();
      glide.dropMomentum(); // drop the phantom's fling so the new gesture starts clean
      wasMultiTouch = false;
    }
    if (pointers.has(event.pointerId)) return; // button chord mid-drag — keep the current gesture
    if (pointers.size >= 2) return; // two fingers own the gesture; a third joins nothing
    if (event.button === 1) event.preventDefault(); // no middle-click autoscroll
    if (pointers.size === 0) {
      panning = event.shiftKey || event.button === 1 || event.button === 2;
      gestureRect = target.getBoundingClientRect();
      viewportHeight = gestureRect.height > 0 ? gestureRect.height : NOMINAL_VIEWPORT_PX;
      wasMultiTouch = false;
    }
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      downX: event.clientX,
      downY: event.clientY,
      downAtMs: performance.now(),
    });
    if (pointers.size === 2) {
      wasMultiTouch = true; // a pinch began — no release in it is a tap
      twistTravelPx = 0; // fresh twist/zoom intent gate for this two-finger gesture
      zoomTravelPx = 0;
      twistEngaged = false;
    }
    target.setPointerCapture?.(event.pointerId); // keep the drag if the cursor leaves the canvas
    applyCursor();
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
    const prevSpread = Math.hypot(moved.x - other.x, moved.y - other.y);
    const prevCx = (moved.x + other.x) / 2;
    const prevCy = (moved.y + other.y) / 2;
    const prevTwist = Math.atan2(moved.y - other.y, moved.x - other.x);
    moved.x = event.clientX;
    moved.y = event.clientY;
    const spread = Math.hypot(moved.x - other.x, moved.y - other.y);
    const cx = (moved.x + other.x) / 2;
    const cy = (moved.y + other.y) / 2;
    const twist = Math.atan2(moved.y - other.y, moved.x - other.x);
    if (cx !== prevCx || cy !== prevCy) {
      glide.pan((cx - prevCx) / viewportHeight, (cy - prevCy) / viewportHeight);
    }
    if (spread > 0 && prevSpread > 0 && spread !== prevSpread) {
      const { cameraPose, setCameraPose } = store.getState();
      const delta = dollyDeltaForScale(prevSpread / spread);
      const rect = gestureRect ?? target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const { x: ndcX, y: ndcY } = clientToNdc(cx, cy, rect);
        setCameraPose(dollyPoseToCursor(cameraPose, delta, ndcX, ndcY, rect.width / rect.height));
      } else {
        setCameraPose(dollyPose(cameraPose, delta));
      }
    }
    // Twist → roll. Shortest-arc the angle delta first — the ±π atan2 branch would otherwise spike
    // it. Until the intent gate opens, accumulate this frame's tangential (rotation) vs radial
    // (zoom) fingertip travel; engage once the twist clears the floor AND outweighs the zoom.
    let dTwist = twist - prevTwist;
    if (dTwist > Math.PI) dTwist -= 2 * Math.PI;
    else if (dTwist < -Math.PI) dTwist += 2 * Math.PI;
    if (!twistEngaged) {
      twistTravelPx += Math.abs(dTwist) * spread; // arc length swept at the orbiting finger
      zoomTravelPx += Math.abs(spread - prevSpread);
      if (twistTravelPx >= TWIST_ENGAGE_PX && twistTravelPx >= TWIST_DOMINANCE * zoomTravelPx) {
        twistEngaged = true; // pre-gate rotation is discarded — track from here, no catch-up jump
      }
    }
    if (twistEngaged && dTwist !== 0) {
      // Screen y is down, so a clockwise on-screen twist increases atan2; +roll banks the camera CW
      // (the world then reads CCW), so flip the sign to make the world follow the fingers.
      const { cameraPose, setCameraPose } = store.getState();
      setCameraPose(rollPose(cameraPose, -dTwist));
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
    if (panning) glide.pan(dx / viewportHeight, dy / viewportHeight);
    else glide.orbit(dx / viewportHeight, dy / viewportHeight);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    const tracked = pointers.get(event.pointerId);
    if (tracked === undefined) return;
    // A clean single-finger tap (touch/pen, never part of a pinch, near-stationary, quick) on a
    // genuine pointerup; two within the window focus like a desktop double-click. pointercancel /
    // lostpointercapture are interruptions, not taps — they break the chain.
    if (event.type === "pointerup") {
      const isTap =
        (event.pointerType === "touch" || event.pointerType === "pen") &&
        !wasMultiTouch &&
        pointers.size === 1 &&
        performance.now() - tracked.downAtMs <= TAP_MAX_MS &&
        Math.hypot(event.clientX - tracked.downX, event.clientY - tracked.downY) <= TAP_SLOP_PX;
      if (
        isTap &&
        performance.now() - lastTapMs <= DBL_TAP_MS &&
        Math.hypot(event.clientX - lastTapX, event.clientY - lastTapY) <= DBL_TAP_SLOP_PX
      ) {
        lastTapMs = Number.NEGATIVE_INFINITY; // consume — a third tap doesn't chain
        triggerFocus(event.clientX, event.clientY);
      } else if (isTap) {
        lastTapMs = performance.now();
        lastTapX = event.clientX;
        lastTapY = event.clientY;
      } else {
        lastTapMs = Number.NEGATIVE_INFINITY; // a drag/pinch release breaks the double-tap chain
      }
    }
    pointers.delete(event.pointerId);
    target.releasePointerCapture?.(event.pointerId);
    applyCursor();
    glide.setPointerDown(pointers.size > 0);
  };

  // Shared dolly-at-cursor path for wheel notches and Safari pinch ratios (both feed pixel-unit
  // deltas). Anchors to the cursor when the target has layout; rides the wheel trail for liveness.
  const dollyAt = (deltaY: number, clientX: number, clientY: number): void => {
    const { cameraPose, setCameraPose } = store.getState();
    // Re-measure only when the previous trail expired — one layout read per burst of notches.
    if (wheelRect === undefined || !glide.isWheelLive()) wheelRect = target.getBoundingClientRect();
    const rect = wheelRect;
    if (rect.width > 0 && rect.height > 0) {
      const { x: ndcX, y: ndcY } = clientToNdc(clientX, clientY, rect); // screen up = +ndcY
      setCameraPose(dollyPoseToCursor(cameraPose, deltaY, ndcX, ndcY, rect.width / rect.height));
    } else {
      setCameraPose(dollyPose(cameraPose, deltaY)); // unlaid-out target — no cursor anchor
    }
    glide.touchWheel();
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault(); // we own the gesture — don't let the page scroll
    dollyAt(
      normalizeWheelDelta(event.deltaY, event.deltaMode, event.ctrlKey),
      event.clientX,
      event.clientY,
    );
  };

  // Safari delivers trackpad pinches as proprietary GestureEvents (never ctrl+wheel — so the wheel
  // path can't double-fire); convert the running scale ratio into the wheel dolly path. iPadOS
  // Safari fires GestureEvents AND pointer events for a two-finger touch pinch — when pointers are
  // live, onPinchMove owns the gesture, so the bridge stands down (else every pinch dollies twice).
  let gestureScale = 1;
  const onGestureStart = (event: Event): void => {
    event.preventDefault();
    if (pointers.size > 0) return;
    gestureScale = 1;
  };
  const onGestureChange = (event: Event): void => {
    event.preventDefault();
    if (pointers.size > 0) return;
    // Safari-proprietary fields, absent from lib.dom — the feature gate below guards the cast.
    const gesture = event as Event & { scale: number; clientX: number; clientY: number };
    if (!(gesture.scale > 0)) return;
    dollyAt(dollyDeltaForScale(gestureScale / gesture.scale), gesture.clientX, gesture.clientY);
    gestureScale = gesture.scale;
  };
  const onGestureEnd = (event: Event): void => {
    event.preventDefault();
  };

  // Pick-to-focus (double-click / touch double-tap): fly the orbit pivot to the feature under the
  // cursor. The box-hit test runs synchronously here (store math); a hit starts the fly toward the
  // chord midpoint the same frame — no worker-round-trip dead time — and dispatches a pick intent
  // the app refines via the worker's opacity-weighted ray march (its pickResult retargets the
  // running flight, masked by the slow ease-in). The goal distance is committed once here and rides
  // the pick request so the retarget can't re-apply ×0.7 to the already-flying pose. A background
  // gesture (ray misses the box) keeps the old reset, where the two can't conflict.
  const focusAt = (clientX: number, clientY: number): void => {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      glide.flyTo(DEFAULT_POSE); // unlaid-out target — no cursor to pick with
      return;
    }
    const { x: ndcX, y: ndcY } = clientToNdc(clientX, clientY, rect); // screen up = +ndcY
    const aspect = rect.width / rect.height;
    const state = store.getState();
    const ray = cursorRay(
      state.cameraPose,
      ndcX,
      ndcY,
      aspect,
      state.projection === "orthographic",
    );
    const midpoint = unitBoxChordMidpoint(ray.origin, ray.dir, state.worldHalfExtent);
    if (midpoint === null) {
      glide.flyTo(DEFAULT_POSE);
      return;
    }
    const distance = focusDistance(state.cameraPose.distance);
    glide.flyTo(focusPoseOnPoint(state.cameraPose, midpoint, distance));
    state.requestPick({ ndcX, ndcY, aspect, purpose: "focus", focusDistance: distance });
  };

  // One focus per gesture: a touch double-tap and the native dblclick some browsers also synthesize
  // for it would otherwise both fire — the window keeps the first.
  const triggerFocus = (clientX: number, clientY: number): void => {
    const now = performance.now();
    if (now - lastFocusMs < DBL_TAP_MS) return;
    lastFocusMs = now;
    focusAt(clientX, clientY);
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    triggerFocus(event.clientX, event.clientY);
  };

  target.addEventListener("pointerdown", onPointerDown, { signal });
  target.addEventListener("pointermove", onPointerMove, { signal });
  target.addEventListener("pointerup", onPointerEnd, { signal });
  target.addEventListener("pointercancel", onPointerEnd, { signal });
  target.addEventListener("lostpointercapture", onPointerEnd, { signal });
  target.addEventListener("dblclick", onDoubleClick, { signal });
  target.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
  // Non-passive: preventDefault needs an explicitly non-passive listener (wheel defaults passive).
  target.addEventListener("wheel", onWheel, { passive: false, signal });
  if ("GestureEvent" in (target.ownerDocument.defaultView ?? {})) {
    // Safari-only trackpad pinch; non-passive so preventDefault stops the page zoom.
    target.addEventListener("gesturestart", onGestureStart, { passive: false, signal });
    target.addEventListener("gesturechange", onGestureChange, { passive: false, signal });
    target.addEventListener("gestureend", onGestureEnd, { passive: false, signal });
  }

  // The picker reports its cursor intent through the store; re-apply when its hover/grab flips so the
  // canvas reflects a marker interaction without the picker ever writing style.cursor itself.
  const subs = createSubscriptions();
  subs.on(store, (s) => s.pickerActive, applyCursor);
  subs.on(store, (s) => s.pickerHover, applyCursor);

  const priorTouchAction = target.style.touchAction;
  target.style.touchAction = "none"; // touch-drag should orbit, not scroll the page
  const priorCursor = target.style.cursor;
  applyCursor();

  return () => {
    ac.abort();
    subs.dispose();
    for (const id of pointers.keys()) target.releasePointerCapture?.(id);
    pointers.clear();
    target.style.touchAction = priorTouchAction;
    target.style.cursor = priorCursor;
  };
}
