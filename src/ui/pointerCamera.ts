import {
  addOrbitMomentum,
  addPanMomentum,
  type BoundingSphere,
  type CameraMomentum,
  type CameraPose,
  cursorRay,
  DEFAULT_POSE,
  dollyDeltaForScale,
  dollyPose,
  dollyPoseToCursor,
  easeInOutCubic,
  isMomentumSettled,
  type KeyNudge,
  MOMENTUM_ZERO,
  normalizeWheelDelta,
  nudgePose,
  poseForBounds,
  poseLerp,
  type SimulationStore,
  stepMomentum,
  UNIT_BOX_RADIUS,
  unitBoxChordMidpoint,
} from "@store";
import type { Disposer } from "./controls/index.ts";
import { isTypingTarget } from "./keyboard.ts";

// Pointer/wheel/keyboard input on the main-thread canvas → camera-pose intents. The OffscreenCanvas
// is transferred to the worker, but the <canvas> element still receives DOM events here; we read the
// live pose from the store, nudge it via the pure helpers (store/camera), and dispatch
// setCameraPose. No render import — ui → store only.
//
// Gestures (OrbitControls/magviz parity): left-drag orbits; shift-, middle- or right-drag pans
// (context menu suppressed); wheel dollies toward the cursor; two touch pointers pinch-dolly about
// their centroid and two-finger-pan. Drag deltas are normalized to viewport-height fractions —
// OrbitControls' unit — so the feel is identical at any canvas size. Drags feed a pending-delta
// momentum that the rAF loop releases through stepMomentum (the damped glide); wheel/pinch dolly is
// immediate (zoom is undamped). The same loop runs the eased fly-to tween (R reset, double-click
// pick-to-focus — background double-click resets — and store cameraFlyRequest intents from the
// gnomon), and reports gesture liveness via setCameraInteracting so the worker can march volumes
// coarser mid-gesture.

// A background-tab resume hands rAF a huge dt; clamp so the glide resumes instead of teleporting.
const GLIDE_MAX_DT_MS = 100;
const NOMINAL_FRAME_MS = 1000 / 60;
// Drag normalization fallback when the canvas has no layout yet (happy-dom tests, hidden mounts).
const NOMINAL_VIEWPORT_PX = 800;
// Eased fly-to duration (reset / axis snap) — magviz's snap feel.
const FLY_MS = 400;
// Wheel has no end event; interaction stays live this long past the last notch.
const WHEEL_TRAIL_MS = 150;
// Fit target until non-cube datasets land: the unit render box's bounding sphere.
const FIT_SPHERE: BoundingSphere = { center: [0, 0, 0], radius: UNIT_BOX_RADIUS };

// Held-key nudges: arrows orbit, -/= dolly ("=" is the unshifted "+"). WASD stays reserved for a
// future fly mode; S/V/F are theme shortcuts. Keyed by event.code, NOT event.key — key is
// modifier-mutated at event time ("=" releases as "+" with Shift held), so a key-tracked Set leaks
// held entries and the dolly runs away; code names the physical key on both edges (magviz does the
// same). Values are the KeyNudge axis + sign each key drives.
const NUDGE_KEYS: ReadonlyMap<string, KeyNudge> = new Map([
  ["ArrowLeft", { azimuth: 1, elevation: 0, dolly: 0 }], // pan the view left = camera sweeps CCW
  ["ArrowRight", { azimuth: -1, elevation: 0, dolly: 0 }],
  ["ArrowUp", { azimuth: 0, elevation: 1, dolly: 0 }],
  ["ArrowDown", { azimuth: 0, elevation: -1, dolly: 0 }],
  ["Equal", { azimuth: 0, elevation: 0, dolly: 1 }],
  ["Minus", { azimuth: 0, elevation: 0, dolly: -1 }],
]);

interface PoseTween {
  readonly from: CameraPose;
  readonly to: CameraPose;
  start: number | undefined; // set on the first glide frame — rAF timestamp domain
}

export function installPointerCamera(target: HTMLElement, store: SimulationStore): Disposer {
  const ac = new AbortController();
  const { signal } = ac;
  // Live pointers (id → last position, mutated in place per move). One pointer drags; two pinch.
  const pointers = new Map<number, { x: number; y: number }>();
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
  // Nudge keys currently held (event.code). The glide loop turns them into constant-velocity
  // motion; opposite keys cancel per-axis.
  const heldKeys = new Set<string>();

  const activeNudge = (): KeyNudge | null => {
    if (heldKeys.size === 0) return null;
    let azimuth = 0;
    let elevation = 0;
    let dolly = 0;
    for (const key of heldKeys) {
      const nudge = NUDGE_KEYS.get(key);
      if (nudge === undefined) continue;
      azimuth += nudge.azimuth;
      elevation += nudge.elevation;
      dolly += nudge.dolly;
    }
    if (azimuth === 0 && elevation === 0 && dolly === 0) return null;
    // Sums of -1|0|1 entries: Math.sign restores the literal range exactly (no NaN — finite ints).
    return {
      azimuth: Math.sign(azimuth) as -1 | 0 | 1,
      elevation: Math.sign(elevation) as -1 | 0 | 1,
      dolly: Math.sign(dolly) as -1 | 0 | 1,
    };
  };

  const applyCursor = (): void => {
    target.style.cursor = pointers.size > 0 ? "grabbing" : "grab";
  };

  // Gesture liveness for the worker's interaction-time quality scaling: any held pointer or nudge
  // key, an unsettled glide, a running tween, or a fresh wheel notch counts as interacting.
  const syncInteracting = (): void => {
    store
      .getState()
      .setCameraInteracting(
        pointers.size > 0 ||
          heldKeys.size > 0 ||
          tween !== undefined ||
          !isMomentumSettled(momentum) ||
          performance.now() < lastWheelMs + WHEEL_TRAIL_MS,
      );
  };

  const glide = (nowMs: number): void => {
    glideId = undefined;
    const dt =
      lastFrameMs === undefined ? NOMINAL_FRAME_MS : Math.min(nowMs - lastFrameMs, GLIDE_MAX_DT_MS);
    lastFrameMs = nowMs;
    const { cameraPose, setCameraPose } = store.getState();
    if (tween !== undefined) {
      if (tween.start === undefined) tween.start = nowMs;
      const t = Math.min((nowMs - tween.start) / FLY_MS, 1);
      // Snap to the exact target at t=1 — poseLerp's exp/log distance round-trip is ~1 ulp off.
      setCameraPose(t >= 1 ? tween.to : poseLerp(tween.from, tween.to, easeInOutCubic(t)));
      if (t >= 1) tween = undefined;
    } else if (!isMomentumSettled(momentum)) {
      const stepped = stepMomentum(cameraPose, momentum, dt);
      momentum = stepped.momentum;
      setCameraPose(stepped.pose);
    }
    // Held nudge keys ride the same loop at constant velocity (re-read the pose — the momentum
    // step above may have moved it this frame). A tween owns the camera while it runs.
    const nudge = tween === undefined ? activeNudge() : null;
    if (nudge !== null) {
      setCameraPose(nudgePose(store.getState().cameraPose, nudge, dt));
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
      syncInteracting(); // false unless a pointer is still held
    } else {
      glideId = requestAnimationFrame(glide);
    }
  };

  const ensureGliding = (): void => {
    if (glideId === undefined) {
      lastFrameMs = undefined; // first frame has no predecessor — step a nominal dt
      glideId = requestAnimationFrame(glide);
    }
  };

  const cancelTween = (): void => {
    tween = undefined;
  };

  const flyTo = (to: CameraPose): void => {
    momentum = MOMENTUM_ZERO; // the tween owns the camera — drop any pending glide
    tween = { from: store.getState().cameraPose, to, start: undefined };
    syncInteracting();
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
    if (pointers.has(event.pointerId)) return; // button chord mid-drag — keep the current gesture
    if (pointers.size >= 2) return; // two fingers own the gesture; a third joins nothing
    if (event.button === 1) event.preventDefault(); // no middle-click autoscroll
    cancelTween();
    if (pointers.size === 0) {
      panning = event.shiftKey || event.button === 1 || event.button === 2;
      gestureRect = target.getBoundingClientRect();
      viewportHeight = gestureRect.height > 0 ? gestureRect.height : NOMINAL_VIEWPORT_PX;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    target.setPointerCapture?.(event.pointerId); // keep the drag if the cursor leaves the canvas
    applyCursor();
    syncInteracting();
  };

  // Two-pointer pinch: dolly by the spread ratio about the centroid (immediate, like wheel) and
  // pan by the centroid translation (damped, like a drag).
  const onPinchMove = (event: PointerEvent, moved: { x: number; y: number }): void => {
    let other: { x: number; y: number } | undefined;
    for (const [id, p] of pointers) {
      if (id !== event.pointerId) other = p;
    }
    if (other === undefined) return;
    const prevSpread = Math.hypot(moved.x - other.x, moved.y - other.y);
    const prevCx = (moved.x + other.x) / 2;
    const prevCy = (moved.y + other.y) / 2;
    moved.x = event.clientX;
    moved.y = event.clientY;
    const spread = Math.hypot(moved.x - other.x, moved.y - other.y);
    const cx = (moved.x + other.x) / 2;
    const cy = (moved.y + other.y) / 2;
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
    if (!pointers.delete(event.pointerId)) return;
    target.releasePointerCapture?.(event.pointerId);
    applyCursor();
    syncInteracting();
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
    syncInteracting();
    ensureGliding(); // the loop expires the wheel trail and flips interacting off
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault(); // we own the gesture — don't let the page scroll
    cancelTween();
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
    cancelTween();
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

  // Double-click = pick-to-focus: fly the orbit pivot to the feature under the cursor. The box-hit
  // test runs synchronously here (store math); a hit dispatches a pick intent the app refines via
  // the worker's opacity-weighted ray march. A background double-click (ray misses the box) keeps
  // the old reset, where the two gestures can't conflict.
  const onDoubleClick = (event: MouseEvent): void => {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      flyTo(DEFAULT_POSE); // unlaid-out target — no cursor to pick with
      return;
    }
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2; // screen up = +ndcY
    const aspect = rect.width / rect.height;
    const state = store.getState();
    const ray = cursorRay(
      state.cameraPose,
      ndcX,
      ndcY,
      aspect,
      state.projection === "orthographic",
    );
    if (unitBoxChordMidpoint(ray.origin, ray.dir) === null) {
      flyTo(DEFAULT_POSE);
      return;
    }
    state.requestPick({ ndcX, ndcY, aspect, purpose: "focus" });
  };

  // Hardcoded "r" (reset) / "z" (fit) / nudge keys until theme shortcuts exist; same guards as
  // ui/install.ts.
  const doc = target.ownerDocument;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    ) {
      // macOS swallows keyup for keys released while Meta is held — a chord starting mid-hold
      // would strand the held set, so a modified keydown drops it (the hard stop is harmless).
      if (heldKeys.size > 0) onWindowBlur();
      return;
    }
    if (isTypingTarget(event.target)) return;
    if (NUDGE_KEYS.has(event.code)) {
      event.preventDefault(); // arrows must not scroll the page while they orbit
      cancelTween();
      heldKeys.add(event.code); // Set-idempotent, so OS key-repeat keydowns are harmless
      syncInteracting();
      ensureGliding();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "r") flyTo(DEFAULT_POSE);
    else if (key === "z") flyToFit();
    else if (key === "o") {
      const state = store.getState();
      state.setProjection(state.projection === "orthographic" ? "perspective" : "orthographic");
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (heldKeys.delete(event.code)) syncInteracting();
  };
  // A key released outside the page (tab switch, cmd-tab) never sends keyup — drop the whole set.
  const onWindowBlur = (): void => {
    if (heldKeys.size === 0) return;
    heldKeys.clear();
    syncInteracting();
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
    if (glideId !== undefined) cancelAnimationFrame(glideId);
    momentum = MOMENTUM_ZERO;
    tween = undefined;
    store.getState().setCameraInteracting(false);
    target.style.touchAction = priorTouchAction;
    target.style.cursor = priorCursor;
  };
}
