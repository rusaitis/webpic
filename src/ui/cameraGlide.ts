import {
  addOrbitMomentum,
  addPanMomentum,
  applyPoseDelta,
  type CameraMomentum,
  type CameraPose,
  easeInOutCubic,
  isMomentumSettled,
  type KeyNudge,
  MOMENTUM_ZERO,
  nudgePose,
  type PoseDelta,
  poseDelta,
  type SimulationStore,
  stepMomentum,
} from "@store";
import { createHeldKeys } from "./heldKeys.ts";
import { frameDt } from "./pointerMath.ts";

// The camera's animation loop: one rAF that releases drag momentum through stepMomentum (the damped
// glide), integrates the held nudge keys at constant velocity, and runs the eased fly-to tween —
// applying eased *increments* on top of the live pose so concurrent input blends with the flight
// instead of canceling it. It is also the single writer of setCameraMotion, the worker's quality
// tier: "gesture" while the hand is on the camera (pointer down, key held, unsettled glide, fresh
// wheel notch), "fly" while only a tween runs, idle on the quiet frame. Gestures (ui/cameraGestures)
// feed it deltas; the composer (ui/pointerCamera) feeds it flights.

// Eased fly-to duration (reset / axis snap / pick-to-focus).
const FLY_MS = 450;
// Wheel has no end event; interaction stays live this long past the last notch.
const WHEEL_TRAIL_MS = 150;

// Held-key nudges: A/D sweep the camera left/right around the target, Q/E
// lower/raise it, W/S (and -/=, "=" being the unshifted "+") dolly in/out. In fly mode (the store's
// isFlyMode, toggled by the rail / N) the loop passes lookMode, flipping A/D/Q/E to first-person
// look (turn in place: D right, E up); orbit otherwise. W/S dolly the same either way — and close up
// that dolly walks the rig forward (dollyWithWalk), the one motion that stays automatic. Shift+Q/E
// reinterpret the same physical keys as roll (banking) — see rollMode below. Arrows belong to the
// point picker (pointerPicker); these remap to translation when a fly mode lands.
const NUDGE_KEYS: ReadonlyMap<string, KeyNudge> = new Map([
  ["KeyA", { azimuth: -1, elevation: 0, dolly: 0, roll: 0 }], // camera sweeps left around the target
  ["KeyD", { azimuth: 1, elevation: 0, dolly: 0, roll: 0 }],
  ["KeyQ", { azimuth: 0, elevation: -1, dolly: 0, roll: 0 }], // camera descends
  ["KeyE", { azimuth: 0, elevation: 1, dolly: 0, roll: 0 }],
  ["KeyW", { azimuth: 0, elevation: 0, dolly: 1, roll: 0 }],
  ["KeyS", { azimuth: 0, elevation: 0, dolly: -1, roll: 0 }],
  ["Equal", { azimuth: 0, elevation: 0, dolly: 1, roll: 0 }],
  ["Minus", { azimuth: 0, elevation: 0, dolly: -1, roll: 0 }],
]);
const NUDGE_CODES: ReadonlySet<string> = new Set(NUDGE_KEYS.keys());

// Shift+Q/E bank the view (roll); the same physical keys orbit (elevation) unshifted. Any other
// shifted keydown — Shift itself included — is a chord that hard-stops a running hold.
const isRollOrNudge = (event: KeyboardEvent): boolean =>
  !event.shiftKey || event.code === "KeyQ" || event.code === "KeyE";

interface PoseTween {
  readonly to: CameraPose; // exact landing pose for an unperturbed flight
  readonly delta: PoseDelta; // live pose → to, computed once at flyTo
  start: number | undefined; // set on the first glide frame — rAF timestamp domain
  easedPrev: number; // ease(t) already applied — per-frame increments sum to exactly 1
  isPerturbed: boolean; // a non-tween writer touched the pose since flyTo
  lastWritten: CameraPose; // the tween's last setCameraPose object — reference identity check
}

export interface CameraGlideHost {
  readonly store: SimulationStore;
  readonly doc: Document;
}

export interface CameraGlide {
  // Drag deltas in viewport-height fractions feed the damped momentum the loop releases.
  orbit(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  // Drop a fling in progress (a purged phantom pointer must not carry its momentum over).
  dropMomentum(): void;
  // Eased flight to `to`; a live fling or fresh input blends in rather than canceling it.
  flyTo(to: CameraPose): void;
  // A wheel notch landed: the interaction stays live for the trail, which the loop expires.
  touchWheel(): void;
  isWheelLive(): boolean;
  // Pointer(s) down on the canvas — the hand is on the camera.
  setPointerDown(down: boolean): void;
  dispose(): void;
}

export function createCameraGlide(host: CameraGlideHost): CameraGlide {
  const { store, doc } = host;
  const ac = new AbortController();
  let momentum: CameraMomentum = MOMENTUM_ZERO;
  let tween: PoseTween | undefined;
  let glideId: number | undefined;
  let lastFrameMs: number | undefined;
  let lastWheelMs = Number.NEGATIVE_INFINITY;
  let pointerDown = false;
  // Subset of the held keys (Q/E) whose elevation intent is reinterpreted as roll (Shift held at
  // keydown). Keyed by code — the modifier-independent name on both edges — so a release can never
  // strand it. Invariant: rollMode ⊆ held.codes.
  const rollMode = new Set<string>();

  const isWheelLive = (): boolean => performance.now() < lastWheelMs + WHEEL_TRAIL_MS;

  const activeNudge = (): KeyNudge | null => {
    if (held.codes.size === 0) return null;
    let azimuth = 0;
    let elevation = 0;
    let dolly = 0;
    let roll = 0;
    for (const code of held.codes) {
      const nudge = NUDGE_KEYS.get(code);
      if (nudge === undefined) continue;
      if (rollMode.has(code)) {
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

  // Priority: any hand-driven input is a "gesture"; a tween alone is a "fly". The store's no-fire
  // guard makes per-frame repeats free.
  const syncMotion = (): void => {
    const gesture =
      pointerDown || held.codes.size > 0 || !isMomentumSettled(momentum) || isWheelLive();
    store.getState().setCameraMotion(gesture ? "gesture" : tween !== undefined ? "fly" : "idle");
  };

  const glide = (nowMs: number): void => {
    glideId = undefined;
    const dt = frameDt(lastFrameMs, nowMs);
    lastFrameMs = nowMs;
    const { cameraPose, setCameraPose } = store.getState();
    if (!isMomentumSettled(momentum)) {
      const stepped = stepMomentum(cameraPose, momentum, dt);
      momentum = stepped.momentum;
      setCameraPose(stepped.pose);
    }
    // Held nudge keys ride the same loop at constant velocity. Fly mode (manual toggle) makes
    // A/D/Q/E first-person look; otherwise they orbit. Read fresh — the momentum step above may have
    // moved the pose this frame.
    const nudge = activeNudge();
    if (nudge !== null) {
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
      if (live !== tween.lastWritten) tween.isPerturbed = true;
      if (t >= 1) {
        // Unperturbed flights land on the exact goal object (pose-permalink determinism); blended
        // ones get the exact remaining fraction, so increments sum to goal ⊕ user input.
        setCameraPose(
          tween.isPerturbed ? applyPoseDelta(live, tween.delta, 1 - tween.easedPrev) : tween.to,
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
      held.codes.size === 0 &&
      nowMs >= lastWheelMs + WHEEL_TRAIL_MS;
    if (quiet) {
      momentum = MOMENTUM_ZERO; // drop the sub-pixel residue so the next drag starts clean
      lastFrameMs = undefined;
    } else {
      glideId = requestAnimationFrame(glide);
    }
    // Per-frame: catches the gesture→fly edge when a wheel trail expires or momentum settles
    // mid-flight, and idle on the quiet frame.
    syncMotion();
  };

  const ensureGliding = (): void => {
    if (glideId === undefined) {
      lastFrameMs = undefined; // first frame has no predecessor — step a nominal dt
      glideId = requestAnimationFrame(glide);
    }
  };

  const held = createHeldKeys(doc, NUDGE_CODES, {
    signal: ac.signal,
    claims: isRollOrNudge,
    shiftIsChord: true,
    onPress: (event) => {
      if (event.shiftKey) rollMode.add(event.code);
      else rollMode.delete(event.code); // unshifted Q/E orbit, not roll
      syncMotion();
      ensureGliding();
    },
    onRelease: () => {
      for (const code of rollMode) if (!held.codes.has(code)) rollMode.delete(code);
      syncMotion();
    },
  });

  return {
    orbit(dx, dy) {
      momentum = addOrbitMomentum(momentum, dx, dy);
      ensureGliding();
    },
    pan(dx, dy) {
      momentum = addPanMomentum(momentum, dx, dy);
      ensureGliding();
    },
    dropMomentum() {
      momentum = MOMENTUM_ZERO;
    },
    // Momentum is NOT zeroed and user input never cancels: a fling in progress glides on through
    // the flight, and a fresh flyTo over a live tween retargets from wherever the camera is.
    flyTo(to) {
      const from = store.getState().cameraPose;
      tween = {
        to,
        delta: poseDelta(from, to),
        start: undefined,
        easedPrev: 0,
        isPerturbed: false,
        lastWritten: from,
      };
      syncMotion();
      ensureGliding();
    },
    touchWheel() {
      lastWheelMs = performance.now();
      syncMotion();
      ensureGliding(); // the loop expires the trail and flips the motion tier back
    },
    isWheelLive,
    setPointerDown(down) {
      pointerDown = down;
      syncMotion();
    },
    dispose() {
      ac.abort();
      if (glideId !== undefined) cancelAnimationFrame(glideId);
      momentum = MOMENTUM_ZERO;
      tween = undefined;
      rollMode.clear();
      store.getState().setCameraMotion("idle");
    },
  };
}
