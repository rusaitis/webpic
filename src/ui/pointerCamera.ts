import {
  addOrbitMomentum,
  addPanMomentum,
  type CameraMomentum,
  type CameraPose,
  DEFAULT_POSE,
  dollyDeltaForScale,
  dollyPose,
  dollyPoseToCursor,
  easeInOutCubic,
  isMomentumSettled,
  MOMENTUM_ZERO,
  poseLerp,
  type SimulationStore,
  stepMomentum,
} from "@store";
import type { Disposer } from "./controls/index.ts";

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
// immediate (zoom is undamped). The same loop runs the eased fly-to tween (R / double-click reset,
// and store cameraFlyRequest intents from the gnomon), and reports gesture liveness via
// setCameraInteracting so the worker can march volumes coarser mid-gesture.

// A background-tab resume hands rAF a huge dt; clamp so the glide resumes instead of teleporting.
const GLIDE_MAX_DT_MS = 100;
const NOMINAL_FRAME_MS = 1000 / 60;
// Drag normalization fallback when the canvas has no layout yet (happy-dom tests, hidden mounts).
const NOMINAL_VIEWPORT_PX = 800;
// Eased fly-to duration (reset / axis snap) — magviz's snap feel.
const FLY_MS = 400;
// Wheel has no end event; interaction stays live this long past the last notch.
const WHEEL_TRAIL_MS = 150;

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

  const measureViewportHeight = (): number => {
    const height = target.getBoundingClientRect().height;
    return height > 0 ? height : NOMINAL_VIEWPORT_PX;
  };

  const applyCursor = (): void => {
    target.style.cursor = pointers.size > 0 ? "grabbing" : "grab";
  };

  // Gesture liveness for the worker's interaction-time quality scaling: any held pointer, an
  // unsettled glide, a running tween, or a fresh wheel notch counts as interacting.
  const syncInteracting = (): void => {
    store
      .getState()
      .setCameraInteracting(
        pointers.size > 0 ||
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
    const quiet =
      tween === undefined && isMomentumSettled(momentum) && nowMs >= lastWheelMs + WHEEL_TRAIL_MS;
    if (quiet) {
      momentum = MOMENTUM_ZERO; // drop the sub-pixel residue so the next drag starts clean
      lastFrameMs = undefined;
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

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    if (pointers.has(event.pointerId)) return; // button chord mid-drag — keep the current gesture
    if (pointers.size >= 2) return; // two fingers own the gesture; a third joins nothing
    if (event.button === 1) event.preventDefault(); // no middle-click autoscroll
    cancelTween();
    if (pointers.size === 0) {
      panning = event.shiftKey || event.button === 1 || event.button === 2;
      viewportHeight = measureViewportHeight();
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
      const rect = target.getBoundingClientRect();
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

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault(); // we own the gesture — don't let the page scroll
    cancelTween();
    const { cameraPose, setCameraPose } = store.getState();
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2; // screen up = +ndcY
      const aspect = rect.width / rect.height;
      setCameraPose(dollyPoseToCursor(cameraPose, event.deltaY, ndcX, ndcY, aspect));
    } else {
      setCameraPose(dollyPose(cameraPose, event.deltaY)); // unlaid-out target — no cursor anchor
    }
    lastWheelMs = performance.now();
    syncInteracting();
    ensureGliding(); // the loop expires the wheel trail and flips interacting off
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    flyTo(DEFAULT_POSE);
  };

  // Hardcoded "r" until a theme shortcut exists; same typing/modifier guards as ui/install.ts.
  const doc = target.ownerDocument;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const focus = event.target;
    if (
      focus instanceof HTMLInputElement ||
      focus instanceof HTMLSelectElement ||
      focus instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (event.key.toLowerCase() === "r") flyTo(DEFAULT_POSE);
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
  doc.addEventListener("keydown", onKeyDown, { signal });

  // Fly-to requests from elsewhere in the ui (gnomon axis snap) arrive as store intents — this
  // module owns the camera animation loop, so it consumes them.
  const unsubscribeFly = store.subscribe(
    (state) => state.cameraFlyRequest,
    (request) => {
      if (request === null) return;
      flyTo(request.pose);
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
    if (glideId !== undefined) cancelAnimationFrame(glideId);
    momentum = MOMENTUM_ZERO;
    tween = undefined;
    store.getState().setCameraInteracting(false);
    target.style.touchAction = priorTouchAction;
    target.style.cursor = priorCursor;
  };
}
