import {
  type AxisView,
  addOrbitMomentum,
  addPanMomentum,
  applyPoseDelta,
  axisViewPose,
  type BoundingSphere,
  type CameraMomentum,
  type CameraPose,
  cursorRay,
  DEFAULT_POSE,
  dollyDeltaForScale,
  dollyPose,
  dollyPoseToCursor,
  easeInOutCubic,
  focusDistance,
  focusPoseOnPoint,
  isMomentumSettled,
  type KeyNudge,
  MOMENTUM_ZERO,
  normalizeWheelDelta,
  nudgePose,
  type PoseDelta,
  poseDelta,
  poseForBounds,
  rollPose,
  type SimulationStore,
  stepMomentum,
  UNIT_BOX_RADIUS,
  unitBoxChordMidpoint,
} from "@store";
import type { Disposer } from "./controls/index.ts";
import { isTypingTarget } from "./keyboard.ts";

// Pointer/wheel/keyboard input on the main-thread canvas → camera-pose intents. The OffscreenCanvas
// is transferred to the worker, but the <canvas> still receives DOM events here; we read the live
// pose from the store, nudge it via the pure helpers (store/camera), and dispatch setCameraPose.
// No render import — ui → store only.
//
// Gestures (OrbitControls/magviz parity): left-drag orbits; shift/middle/right-drag pans (context
// menu suppressed); wheel dollies toward the cursor; two pointers pinch-dolly about their centroid
// and two-finger-pan. Drag deltas are normalized to viewport-height fractions (OrbitControls' unit),
// so the feel is identical at any canvas size. Drags feed a pending-delta momentum the rAF loop
// releases through stepMomentum (the damped glide); wheel/pinch dolly is immediate. The same loop
// runs the eased fly-to tween (R reset, double-click pick-to-focus, gnomon cameraFlyRequest),
// applying eased *increments* on top of the live pose so concurrent input blends with the flight
// instead of canceling it. Motion liveness rides setCameraMotion — "gesture" while the hand is on the
// camera (coarse march), "fly" while only a tween runs (gentler tier, since it's short and predictable).

// A background-tab resume hands rAF a huge dt; clamp so the glide resumes instead of teleporting.
const GLIDE_MAX_DT_MS = 100;
const NOMINAL_FRAME_MS = 1000 / 60;
// Drag normalization fallback when the canvas has no layout yet (happy-dom tests, hidden mounts).
const NOMINAL_VIEWPORT_PX = 800;
// Eased fly-to duration (reset / axis snap / pick-to-focus) — magviz's 0.45 s focus glide.
const FLY_MS = 450;
// Wheel has no end event; interaction stays live this long past the last notch.
const WHEEL_TRAIL_MS = 150;
// Fit target until non-cube datasets land: the unit render box's bounding sphere.
const FIT_SPHERE: BoundingSphere = { center: [0, 0, 0], radius: UNIT_BOX_RADIUS };

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

// Held-key nudges (magviz's orbit keys): A/D sweep the camera left/right around the target, Q/E
// lower/raise it, W/S (and -/=, "=" being the unshifted "+") dolly in/out. In fly mode (the store's
// isFlyMode, toggled by the rail / N) the glide loop passes lookMode, flipping A/D/Q/E to first-person
// look (turn in place: D right, E up); orbit otherwise. W/S dolly the same either way — and close up
// that dolly walks the rig forward (dollyWithWalk), the one motion that stays automatic. Shift+Q/E
// reinterpret the same physical keys as roll (banking) — see rollMode in onKeyDown. Arrows belong to
// the point picker (pointerPicker); these remap to translation when a fly mode lands.
// Keyed by event.code, NOT event.key — key is modifier-mutated ("=" releases as "+" with Shift
// held), so a key-tracked Set leaks held entries and the dolly runs away; code names the physical
// key on both edges (magviz does the same).
const NUDGE_KEYS: ReadonlyMap<string, KeyNudge> = new Map([
  ["KeyA", { azimuth: -1, elevation: 0, dolly: 0, roll: 0 }], // camera sweeps left around the target
  ["KeyD", { azimuth: 1, elevation: 0, dolly: 0, roll: 0 }],
  ["KeyQ", { azimuth: 0, elevation: -1, dolly: 0, roll: 0 }], // camera descends (magviz orbit/fly parity)
  ["KeyE", { azimuth: 0, elevation: 1, dolly: 0, roll: 0 }],
  ["KeyW", { azimuth: 0, elevation: 0, dolly: 1, roll: 0 }],
  ["KeyS", { azimuth: 0, elevation: 0, dolly: -1, roll: 0 }],
  ["Equal", { azimuth: 0, elevation: 0, dolly: 1, roll: 0 }],
  ["Minus", { azimuth: 0, elevation: 0, dolly: -1, roll: 0 }],
]);

// Tap-to-snap axis views (z-up: Top = +z). Digit 0 / backtick returns to the default 3/4 view.
// Keyed by event.code so the digit row works regardless of layout. null = the home pose.
const AXIS_KEYS: ReadonlyMap<string, AxisView | null> = new Map([
  ["Digit1", "+x"], // front
  ["Digit2", "-x"], // back
  ["Digit3", "+y"], // right
  ["Digit4", "-y"], // left
  ["Digit5", "+z"], // top
  ["Digit6", "-z"], // bottom
  ["Digit0", null],
  ["Backquote", null],
]);

interface PoseTween {
  readonly to: CameraPose; // exact landing pose for an unperturbed flight
  readonly delta: PoseDelta; // live pose → to, computed once at flyTo
  start: number | undefined; // set on the first glide frame — rAF timestamp domain
  easedPrev: number; // ease(t) already applied — per-frame increments sum to exactly 1
  perturbed: boolean; // a non-tween writer touched the pose since flyTo
  lastWritten: CameraPose; // the tween's last setCameraPose object — reference identity check
}

export function installPointerCamera(target: HTMLElement, store: SimulationStore): Disposer {
  const ac = new AbortController();
  const { signal } = ac;
  // Live pointers (id → live position + immutable press origin/time). x/y are mutated in place per
  // move; downX/downY/downAtMs are fixed at press and only read for tap detection. One drags; two pinch.
  const pointers = new Map<
    number,
    { x: number; y: number; downX: number; downY: number; downAtMs: number }
  >();
  let panning = false;
  let viewportHeight = NOMINAL_VIEWPORT_PX; // measured per gesture; drags normalize px by this
  let momentum: CameraMomentum = MOMENTUM_ZERO;
  let tween: PoseTween | undefined;
  let glideId: number | undefined;
  let lastFrameMs: number | undefined;
  let lastWheelMs = Number.NEGATIVE_INFINITY;
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
  // Nudge keys currently held (event.code). The glide loop turns them into constant-velocity
  // motion; opposite keys cancel per-axis.
  const heldKeys = new Set<string>();
  // Subset of heldKeys (Q/E) whose elevation intent is reinterpreted as roll (Shift held at
  // keydown). Kept keyed by code — the modifier-independent name on both edges — so keyup/blur
  // can never strand it. Invariant: rollMode ⊆ heldKeys.
  const rollMode = new Set<string>();

  const activeNudge = (): KeyNudge | null => {
    if (heldKeys.size === 0) return null;
    let azimuth = 0;
    let elevation = 0;
    let dolly = 0;
    let roll = 0;
    for (const key of heldKeys) {
      const nudge = NUDGE_KEYS.get(key);
      if (nudge === undefined) continue;
      if (rollMode.has(key)) {
        roll += nudge.elevation; // Shift+E (elev +1) banks right; Shift+Q (elev -1) banks left
      } else {
        azimuth += nudge.azimuth;
        elevation += nudge.elevation;
        dolly += nudge.dolly;
      }
    }
    if (azimuth === 0 && elevation === 0 && dolly === 0 && roll === 0) return null;
    // Sums of -1|0|1 entries: Math.sign restores the literal range exactly (no NaN — finite ints).
    return {
      azimuth: Math.sign(azimuth) as -1 | 0 | 1,
      elevation: Math.sign(elevation) as -1 | 0 | 1,
      dolly: Math.sign(dolly) as -1 | 0 | 1,
      roll: Math.sign(roll) as -1 | 0 | 1,
    };
  };

  const applyCursor = (): void => {
    target.style.cursor = pointers.size > 0 ? "grabbing" : "grab";
  };

  // Motion liveness for the worker's quality scaling. Priority: any hand-driven input (held
  // pointer or nudge key, unsettled glide, fresh wheel notch) is a "gesture"; a tween alone is a
  // "fly". The store's no-fire guard makes per-frame repeats free.
  const syncMotion = (): void => {
    const gesture =
      pointers.size > 0 ||
      heldKeys.size > 0 ||
      !isMomentumSettled(momentum) ||
      performance.now() < lastWheelMs + WHEEL_TRAIL_MS;
    store.getState().setCameraMotion(gesture ? "gesture" : tween !== undefined ? "fly" : "idle");
  };

  const glide = (nowMs: number): void => {
    glideId = undefined;
    const dt =
      lastFrameMs === undefined ? NOMINAL_FRAME_MS : Math.min(nowMs - lastFrameMs, GLIDE_MAX_DT_MS);
    lastFrameMs = nowMs;
    const { cameraPose, setCameraPose } = store.getState();
    if (!isMomentumSettled(momentum)) {
      const stepped = stepMomentum(cameraPose, momentum, dt);
      momentum = stepped.momentum;
      setCameraPose(stepped.pose);
    }
    // Held nudge keys ride the same loop at constant velocity (re-read the pose — the momentum
    // step above may have moved it this frame).
    const nudge = activeNudge();
    if (nudge !== null) {
      // Fly mode (manual toggle) makes A/D/Q/E first-person look; otherwise they orbit. Read fresh —
      // re-read the pose too (the momentum step above may have moved it this frame).
      const state = store.getState();
      setCameraPose(nudgePose(state.cameraPose, nudge, dt, state.isFlyMode));
    }
    // The tween steps last so its perturbation check sees this frame's user motion: any pose
    // object it didn't write means a drag/wheel/momentum blended in, and the flight must keep
    // applying increments instead of snapping to the absolute goal at landing.
    if (tween !== undefined) {
      if (tween.start === undefined) tween.start = nowMs;
      const t = Math.min((nowMs - tween.start) / FLY_MS, 1);
      const live = store.getState().cameraPose;
      if (live !== tween.lastWritten) tween.perturbed = true;
      if (t >= 1) {
        // Unperturbed flights land on the exact goal object (pose-permalink determinism); blended
        // ones get the exact remaining fraction, so increments sum to goal ⊕ user input.
        setCameraPose(
          tween.perturbed ? applyPoseDelta(live, tween.delta, 1 - tween.easedPrev) : tween.to,
        );
        tween = undefined;
      } else {
        const eased = easeInOutCubic(t);
        const next = applyPoseDelta(live, tween.delta, eased - tween.easedPrev);
        setCameraPose(next);
        tween.easedPrev = eased;
        tween.lastWritten = next;
      }
    }
    const quiet =
      tween === undefined &&
      isMomentumSettled(momentum) &&
      heldKeys.size === 0 &&
      nowMs >= lastWheelMs + WHEEL_TRAIL_MS;
    if (quiet) {
      momentum = MOMENTUM_ZERO; // drop the sub-pixel residue so the next drag starts clean
      lastFrameMs = undefined;
      wheelRect = undefined; // next wheel trail re-measures (the canvas may have resized since)
    } else {
      glideId = requestAnimationFrame(glide);
    }
    // Per-frame (store no-fire guard makes repeats free): catches the gesture→fly edge when a
    // wheel trail expires or momentum settles mid-flight, and idle on the quiet frame.
    syncMotion();
  };

  const ensureGliding = (): void => {
    if (glideId === undefined) {
      lastFrameMs = undefined; // first frame has no predecessor — step a nominal dt
      glideId = requestAnimationFrame(glide);
    }
  };

  // Momentum is NOT zeroed and user input never cancels: a fling in progress glides on through
  // the flight, and a fresh flyTo over a live tween retargets from wherever the camera is.
  const flyTo = (to: CameraPose): void => {
    const from = store.getState().cameraPose;
    tween = {
      to,
      delta: poseDelta(from, to),
      start: undefined,
      easedPrev: 0,
      perturbed: false,
      lastWritten: from,
    };
    syncMotion();
    ensureGliding();
  };

  // Frame the data (Z / "Fit view"): keep the viewing direction, recenter + back off to fit the
  // unit render box. Resolved here — only this module knows the canvas aspect the fit needs.
  const flyToFit = (): void => {
    const rect = target.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1;
    flyTo(poseForBounds(store.getState().cameraPose, FIT_SPHERE, aspect));
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    // A primary pointer means no others are physically down: anything still tracked is a phantom
    // from a multitouch release the browser never delivered (iOS/Android drop these mid-pinch),
    // which would otherwise lock the gesture at size >= 2 forever. Purge before this one joins.
    if (event.isPrimary && pointers.size > 0) {
      for (const id of pointers.keys()) target.releasePointerCapture?.(id);
      pointers.clear();
      momentum = MOMENTUM_ZERO; // drop the phantom's fling so the new gesture starts clean
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
    syncMotion();
  };

  // Two-pointer pinch: dolly by the spread ratio about the centroid (immediate, like wheel), pan by
  // the centroid translation (damped, like a drag), and roll by the finger-pair twist (immediate,
  // once it out-votes the zoom). All three compose — an RTS-style zoom/pan/rotate in one gesture.
  const onPinchMove = (event: PointerEvent, moved: { x: number; y: number }): void => {
    let other: { x: number; y: number } | undefined;
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
      momentum = addPanMomentum(
        momentum,
        (cx - prevCx) / viewportHeight,
        (cy - prevCy) / viewportHeight,
      );
    }
    if (spread > 0 && prevSpread > 0 && spread !== prevSpread) {
      const { cameraPose, setCameraPose } = store.getState();
      const delta = dollyDeltaForScale(prevSpread / spread);
      const rect = gestureRect ?? target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const ndcX = ((cx - rect.left) / rect.width) * 2 - 1;
        const ndcY = 1 - ((cy - rect.top) / rect.height) * 2;
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
    ensureGliding();
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
    momentum = panning
      ? addPanMomentum(momentum, dx / viewportHeight, dy / viewportHeight)
      : addOrbitMomentum(momentum, dx / viewportHeight, dy / viewportHeight);
    ensureGliding();
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
    syncMotion();
  };

  // Shared dolly-at-cursor path for wheel notches and Safari pinch ratios (both feed pixel-unit
  // deltas). Anchors to the cursor when the target has layout; rides the wheel trail for liveness.
  const dollyAt = (deltaY: number, clientX: number, clientY: number): void => {
    const { cameraPose, setCameraPose } = store.getState();
    // Re-measure only when the previous trail expired — one layout read per burst of notches.
    if (wheelRect === undefined || performance.now() >= lastWheelMs + WHEEL_TRAIL_MS) {
      wheelRect = target.getBoundingClientRect();
    }
    const rect = wheelRect;
    if (rect.width > 0 && rect.height > 0) {
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2; // screen up = +ndcY
      const aspect = rect.width / rect.height;
      setCameraPose(dollyPoseToCursor(cameraPose, deltaY, ndcX, ndcY, aspect));
    } else {
      setCameraPose(dollyPose(cameraPose, deltaY)); // unlaid-out target — no cursor anchor
    }
    lastWheelMs = performance.now();
    syncMotion();
    ensureGliding(); // the loop expires the wheel trail and flips interacting off
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
      flyTo(DEFAULT_POSE); // unlaid-out target — no cursor to pick with
      return;
    }
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2; // screen up = +ndcY
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
      flyTo(DEFAULT_POSE);
      return;
    }
    const distance = focusDistance(state.cameraPose.distance);
    flyTo(focusPoseOnPoint(state.cameraPose, midpoint, distance));
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

  // Hardcoded shortcuts until theme shortcuts exist; same guards as ui/install.ts. R reset, Z fit,
  // O projection, 1–6/0 axis snaps, W/A/S/D/Q/E orbit+dolly, Shift+Q/E roll, Shift+R level horizon.
  const doc = target.ownerDocument;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) {
      // macOS swallows keyup for keys released while Meta is held — a chord starting mid-hold
      // would strand the held set, so a modified keydown drops it (the hard stop is harmless).
      if (heldKeys.size > 0) onWindowBlur();
      return;
    }
    if (isTypingTarget(event.target)) return;
    // Shift+Q/E bank the view (roll); the same physical keys orbit (elevation) unshifted. rollMode
    // records the mode per code so a later keyup/blur clears it regardless of the modifier state.
    if (event.shiftKey) {
      if (event.code === "KeyQ" || event.code === "KeyE") {
        event.preventDefault();
        heldKeys.add(event.code);
        rollMode.add(event.code);
        syncMotion();
        ensureGliding();
      } else if (event.code === "KeyR") {
        event.preventDefault();
        flyTo({ ...store.getState().cameraPose, roll: 0 }); // level the horizon, view held
      } else if (heldKeys.size > 0) {
        onWindowBlur(); // a stray Shift chord must not strand a held nudge
      }
      return;
    }
    if (NUDGE_KEYS.has(event.code)) {
      event.preventDefault(); // claimed — no quick-find / page side effects while orbiting
      heldKeys.add(event.code); // Set-idempotent, so OS key-repeat keydowns are harmless
      rollMode.delete(event.code); // unshifted Q/E orbit, not roll
      syncMotion();
      ensureGliding();
      return;
    }
    const axis = AXIS_KEYS.get(event.code);
    if (axis !== undefined) {
      event.preventDefault();
      flyTo(axis === null ? DEFAULT_POSE : axisViewPose(axis, store.getState().cameraPose));
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "r") flyTo(DEFAULT_POSE);
    else if (key === "z") flyToFit();
    else if (key === "o") {
      const state = store.getState();
      state.setProjection(state.projection === "orthographic" ? "perspective" : "orthographic");
    } else if (key === "n") store.getState().toggleFlyMode(); // orbit ⇄ fly (first-person look)
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    rollMode.delete(event.code);
    if (heldKeys.delete(event.code)) syncMotion();
  };
  // A key released outside the page (tab switch, cmd-tab) never sends keyup — drop the whole set.
  const onWindowBlur = (): void => {
    if (heldKeys.size === 0) return;
    heldKeys.clear();
    rollMode.clear();
    syncMotion();
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
  if ("GestureEvent" in (doc.defaultView ?? {})) {
    // Safari-only trackpad pinch; non-passive so preventDefault stops the page zoom.
    target.addEventListener("gesturestart", onGestureStart, { passive: false, signal });
    target.addEventListener("gesturechange", onGestureChange, { passive: false, signal });
    target.addEventListener("gestureend", onGestureEnd, { passive: false, signal });
  }
  doc.addEventListener("keydown", onKeyDown, { signal });
  doc.addEventListener("keyup", onKeyUp, { signal });
  doc.defaultView?.addEventListener("blur", onWindowBlur, { signal });

  // Fly-to requests from elsewhere in the ui (gnomon axis snap, Fit view button) arrive as store
  // intents — this module owns the camera animation loop, so it consumes (and resolves) them.
  const unsubscribeFly = store.subscribe(
    (state) => state.cameraFlyRequest,
    (request) => {
      if (request === null) return;
      const fly = request.target;
      if (fly.kind === "pose") flyTo(fly.pose);
      else flyToFit();
      store.getState().requestCameraFly(null); // consume — a repeat of the same view re-fires
    },
  );

  const priorTouchAction = target.style.touchAction;
  target.style.touchAction = "none"; // touch-drag should orbit, not scroll the page
  const priorCursor = target.style.cursor;
  applyCursor();

  return () => {
    ac.abort();
    unsubscribeFly();
    for (const id of pointers.keys()) target.releasePointerCapture?.(id);
    pointers.clear();
    heldKeys.clear();
    rollMode.clear();
    if (glideId !== undefined) cancelAnimationFrame(glideId);
    momentum = MOMENTUM_ZERO;
    tween = undefined;
    store.getState().setCameraMotion("idle");
    target.style.touchAction = priorTouchAction;
    target.style.cursor = priorCursor;
  };
}
