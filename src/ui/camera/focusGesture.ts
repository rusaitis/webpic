import {
  cursorRay,
  DEFAULT_POSE,
  focusDistance,
  focusPoseOnPoint,
  type SimulationStore,
  unitBoxChordMidpoint,
} from "@store";
import { clientToNdc } from "../pointerMath.ts";
import { DOUBLE_TAP_MS } from "./gestureRecognizers.ts";
import type { CameraGlide } from "./glide.ts";

// Pick-to-focus (double-click, or a touch double-tap the pointer path detects): fly the orbit pivot
// to the feature under the cursor. The box-hit test runs synchronously (store math); a hit starts
// the fly toward the chord midpoint the same frame — no worker round-trip dead time — and dispatches
// a pick intent the app refines via the worker's opacity-weighted ray march, whose pickResult
// retargets the running flight behind the slow ease-in. A background gesture (ray misses the box)
// resets the view instead.

export interface FocusGesture {
  // Fire a focus at a client point, de-duped against the native dblclick some browsers synthesize
  // for a touch double-tap — otherwise one gesture focuses twice.
  triggerFocus(clientX: number, clientY: number): void;
}

export function installFocusGesture(
  target: HTMLElement,
  store: SimulationStore,
  glide: CameraGlide,
  signal: AbortSignal,
): FocusGesture {
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
    // The goal distance is committed once here and rides the pick request, so the retarget cannot
    // re-apply ×0.7 to the already-flying pose.
    const distance = focusDistance(state.cameraPose.distance);
    glide.flyTo(focusPoseOnPoint(state.cameraPose, midpoint, distance));
    state.requestPick({ ndcX, ndcY, aspect, purpose: "focus", focusDistance: distance });
  };

  let lastFocusMs = Number.NEGATIVE_INFINITY;
  const triggerFocus = (clientX: number, clientY: number): void => {
    const now = performance.now();
    if (now - lastFocusMs < DOUBLE_TAP_MS) return; // the window keeps the first of the pair
    lastFocusMs = now;
    focusAt(clientX, clientY);
  };

  target.addEventListener(
    "dblclick",
    (event: MouseEvent) => {
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      triggerFocus(event.clientX, event.clientY);
    },
    { signal },
  );

  return { triggerFocus };
}
