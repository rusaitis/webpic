import { horizontalDragAllowed, type MarkerPart, verticalDragAllowed } from "@schema/marker.ts";
import type { Vec3 } from "@schema/types.ts";
import {
  clampToBox,
  cursorRay,
  dragAlongAxis,
  dragOnPlane,
  markerEdgePoint,
  markerHandlePositions,
  type SimulationStore,
  worldToScreen,
} from "@store";
import type { Disposer } from "./controls/index.ts";
import { createHeldKeys } from "./heldKeys.ts";
import { clientToNdc, frameDt } from "./pointerMath.ts";

// Point-picker pointer input on the main-thread canvas. Capture-phase, so it runs before
// pointerCamera's bubble-phase handlers on the same element: a pointerdown that grabs the marker (or
// a handle) calls stopImmediatePropagation so the camera never orbits; everything else falls through
// to pointerCamera unchanged. The marker lives in the worker, so the hit test projects its world
// position (store/marker.worldToScreen) and drags solve against the pure pose-driven ray math, then
// dispatch store intents. ui → store only — no render import. Gestures: DESIGN §Point-picker gestures.

// Hover/grab target: 2× the marker's projected core radius — tracking the rendered size across
// dolly — with a floor so it never shrinks into a flickery sliver. Core and handle stems share it
// (max(26, radiusPx·2)).
const MIN_HIT_PX = 26;
const HIT_RADIUS_FACTOR = 2;
const MARKER_KEY_SPEED = 0.5; // marker slide speed while an arrow is held, box units / s
const ARROW_CODES: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

interface ClientPoint {
  readonly x: number;
  readonly y: number;
}

type DragMode =
  | { readonly kind: "plane"; readonly planePoint: Vec3; readonly normal: Vec3 }
  | { readonly kind: "axis"; readonly origin: Vec3; readonly dir: Vec3 };

interface ActiveDrag {
  readonly pointerId: number;
  readonly mode: DragMode;
  readonly grabOffset: Vec3;
  readonly part: MarkerPart;
  readonly rect: DOMRect;
}

function distanceToSegment(p: ClientPoint, a: ClientPoint, b: ClientPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function installPointerPicker(target: HTMLElement, store: SimulationStore): Disposer {
  const abortController = new AbortController();
  const { signal } = abortController;
  let drag: ActiveDrag | undefined;

  const clientOf = (ndcX: number, ndcY: number, rect: DOMRect): ClientPoint => ({
    x: rect.left + ((ndcX + 1) / 2) * rect.width,
    y: rect.top + ((1 - ndcY) / 2) * rect.height,
  });

  // Which marker part (if any) the cursor is over, in screen space. Core first (the inner region is a
  // free-plane grab), then the ↕/↔ handle stems/knobs (the outer affordances).
  const markerPartAt = (clientX: number, clientY: number, rect: DOMRect): MarkerPart => {
    const { pickerPoint, cameraPose, projection, overlay } = store.getState();
    if (!overlay.showPicker || pickerPoint === null || rect.width <= 0 || rect.height <= 0) {
      return "none";
    }
    const ortho = projection === "orthographic";
    const aspect = rect.width / rect.height;
    const core = worldToScreen(cameraPose, pickerPoint, aspect, ortho);
    if (core.behind) return "none";
    const corePx = clientOf(core.ndcX, core.ndcY, rect);
    const cursor: ClientPoint = { x: clientX, y: clientY };
    const edge = worldToScreen(
      cameraPose,
      markerEdgePoint(cameraPose, pickerPoint, ortho),
      aspect,
      ortho,
    );
    const edgePx = clientOf(edge.ndcX, edge.ndcY, rect);
    const hitPx = Math.max(
      MIN_HIT_PX,
      HIT_RADIUS_FACTOR * Math.hypot(edgePx.x - corePx.x, edgePx.y - corePx.y),
    );
    if (Math.hypot(clientX - corePx.x, clientY - corePx.y) <= hitPx) return "core";
    const handles = markerHandlePositions(cameraPose, pickerPoint, ortho);
    // Each handle is a stem from the core to its knob; the grab target is the whole segment.
    const stems = [
      ["vertical", handles.vertical],
      ["horizontal", handles.horizontal?.position ?? null],
    ] as const satisfies ReadonlyArray<readonly [MarkerPart, Vec3 | null]>;
    for (const [part, knob] of stems) {
      if (knob === null) continue;
      const knobScreen = worldToScreen(cameraPose, knob, aspect, ortho);
      if (knobScreen.behind) continue;
      const knobPx = clientOf(knobScreen.ndcX, knobScreen.ndcY, rect);
      if (distanceToSegment(cursor, corePx, knobPx) <= hitPx) return part;
    }
    return "none";
  };

  // Build the drag mode for the grabbed part: handles + Shift lock to a single axis, a steep view
  // forces vertical, the equatorial regime drags on a screen-facing vertical plane, and the common
  // mid-elevation core grab drags on the horizontal (xy) plane at the marker's height.
  const buildMode = (part: MarkerPart, point: Vec3, isShiftHeld: boolean): DragMode => {
    const { cameraPose, projection } = store.getState();
    const ortho = projection === "orthographic";
    if (part === "vertical") return { kind: "axis", origin: point, dir: [0, 0, 1] };
    if (part === "horizontal") {
      const axis = markerHandlePositions(cameraPose, point, ortho).horizontal?.axis ?? "x";
      return { kind: "axis", origin: point, dir: axis === "y" ? [0, 1, 0] : [1, 0, 0] };
    }
    if (isShiftHeld && verticalDragAllowed(cameraPose))
      return { kind: "axis", origin: point, dir: [0, 0, 1] };
    if (horizontalDragAllowed(cameraPose)) {
      return { kind: "plane", planePoint: point, normal: [0, 0, 1] };
    }
    // Near edge-on: an xy-plane drag is ill-conditioned, so drag on the vertical plane facing the
    // camera (normal = the horizontal view direction) — 2-DOF, well-conditioned.
    const ca = Math.cos(cameraPose.azimuth);
    const sa = Math.sin(cameraPose.azimuth);
    return { kind: "plane", planePoint: point, normal: [ca, sa, 0] };
  };

  const solve = (mode: DragMode, ndcX: number, ndcY: number, rect: DOMRect): Vec3 | null => {
    const { cameraPose, projection } = store.getState();
    const ortho = projection === "orthographic";
    const ray = cursorRay(cameraPose, ndcX, ndcY, rect.width / rect.height, ortho);
    return mode.kind === "plane"
      ? dragOnPlane(ray, mode.planePoint, mode.normal)
      : dragAlongAxis(ray, mode.origin, mode.dir);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) return; // primary left-button only; rest → camera
    const rect = target.getBoundingClientRect();
    const part = markerPartAt(event.clientX, event.clientY, rect);
    if (part === "none") return; // not on the marker — let the event reach pointerCamera (orbit/pan)

    // Claim the marker interaction: the camera must not orbit. stopImmediatePropagation (not
    // preventDefault) so the native dblclick still reaches pointerCamera for focus.
    event.stopImmediatePropagation();
    target.setPointerCapture?.(event.pointerId);
    const point = store.getState().pickerPoint;
    if (point === null) return;
    const mode = buildMode(part, point, event.shiftKey);
    const ndc = clientToNdc(event.clientX, event.clientY, rect);
    const grab = solve(mode, ndc.x, ndc.y, rect);
    const grabOffset: Vec3 =
      grab !== null ? [grab[0] - point[0], grab[1] - point[1], grab[2] - point[2]] : [0, 0, 0];
    drag = { pointerId: event.pointerId, mode, grabOffset, part, rect };
    store.getState().setPickerHover(part);
    store.getState().setPickerActive(true); // pointerCamera reads this to show the grabbing cursor
  };

  const onPointerMove = (event: PointerEvent): void => {
    const state = store.getState(); // one snapshot per move (drag-apply + hover both read it)
    if (drag !== undefined && event.pointerId === drag.pointerId) {
      event.stopImmediatePropagation();
      const ndc = clientToNdc(event.clientX, event.clientY, drag.rect);
      const hit = solve(drag.mode, ndc.x, ndc.y, drag.rect);
      if (hit === null) return; // grazing plane — keep the marker put
      state.setPickerPoint(
        clampToBox(
          [hit[0] - drag.grabOffset[0], hit[1] - drag.grabOffset[1], hit[2] - drag.grabOffset[2]],
          state.worldHalfExtent,
        ),
      );
      return;
    }
    if (event.buttons !== 0) return; // a camera drag owns the gesture — don't update hover under it
    // No marker to hover (the common picker-hidden case): mirror the "none" outcome without paying
    // markerPartAt's forced-layout rect read + projections on every move. Hover drives the cursor
    // (pointerCamera reads pickerHover) — no style.cursor write here.
    const { overlay, pickerPoint } = state;
    if (!overlay.showPicker || pickerPoint === null) {
      state.setPickerHover("none");
      return;
    }
    const rect = target.getBoundingClientRect();
    const part = markerPartAt(event.clientX, event.clientY, rect);
    state.setPickerHover(part);
  };

  // A completed drag swallows the event so the camera never also reads it as a click; a cancel
  // (pointer stolen by the browser) has nothing to swallow.
  const endDrag = (event: PointerEvent, { shouldSwallow }: { shouldSwallow: boolean }): void => {
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    if (shouldSwallow) event.stopImmediatePropagation();
    target.releasePointerCapture?.(event.pointerId);
    drag = undefined;
    store.getState().setPickerActive(false);
  };
  const onPointerUp = (event: PointerEvent): void => endDrag(event, { shouldSwallow: true });
  const onPointerCancel = (event: PointerEvent): void => endDrag(event, { shouldSwallow: false });

  // Held arrows integrate in a rAF loop (dt-scaled, constant speed). pickerActive rides the hold:
  // the marker shows its grab affordance, and the move reads as a drag, not a stream of placements
  // (markerScene re-pulses on a point that moves while inactive). Unclaimed while the marker is
  // hidden, so the page keeps its arrows.
  let arrowRafId: number | undefined;
  let lastArrowMs: number | undefined;

  const stopSlide = (): void => {
    if (arrowRafId !== undefined) cancelAnimationFrame(arrowRafId);
    arrowRafId = undefined;
    lastArrowMs = undefined;
    if (drag === undefined) store.getState().setPickerActive(false);
  };

  const arrows = createHeldKeys(target.ownerDocument, ARROW_CODES, {
    signal,
    claims: () => {
      const { overlay, pickerPoint } = store.getState();
      return overlay.showPicker && pickerPoint !== null;
    },
    onPress: () => {
      if (drag === undefined) store.getState().setPickerActive(true);
      if (arrowRafId === undefined) arrowRafId = requestAnimationFrame(arrowStep);
    },
    onRelease: () => {
      if (arrows.codes.size === 0) stopSlide();
    },
  });

  const arrowStep = (nowMs: number): void => {
    arrowRafId = undefined;
    const dtMs = frameDt(lastArrowMs, nowMs);
    lastArrowMs = nowMs;
    const state = store.getState();
    const point = state.pickerPoint;
    if (!state.overlay.showPicker || point === null) {
      arrows.drop(); // the marker vanished mid-hold (toggle) — stop, don't drive a ghost
      return;
    }
    const held = arrows.codes;
    const lr = (held.has("ArrowRight") ? 1 : 0) - (held.has("ArrowLeft") ? 1 : 0);
    const ud = (held.has("ArrowUp") ? 1 : 0) - (held.has("ArrowDown") ? 1 : 0);
    const sa = Math.sin(state.cameraPose.azimuth);
    const ca = Math.cos(state.cameraPose.azimuth);
    // screenRight = (−sa, ca, 0) — worldToScreen's basis; into-screen horizontal = (−ca, −sa, 0).
    const dx = lr * -sa + (arrows.isShiftHeld ? 0 : ud * -ca);
    const dy = lr * ca + (arrows.isShiftHeld ? 0 : ud * -sa);
    const dz = arrows.isShiftHeld ? ud : 0;
    const len = Math.hypot(dx, dy, dz);
    if (len > 0) {
      const step = (MARKER_KEY_SPEED * dtMs) / 1000 / len; // unit direction — diagonals same speed
      state.setPickerPoint(
        clampToBox(
          [point[0] + dx * step, point[1] + dy * step, point[2] + dz * step],
          state.worldHalfExtent,
        ),
      );
      // Re-assert after a concurrent pointer-drag release cleared it mid-hold (store dedupes).
      if (drag === undefined) state.setPickerActive(true);
    }
    if (held.size > 0) arrowRafId = requestAnimationFrame(arrowStep);
  };

  // Capture phase so these run before pointerCamera's bubble-phase listeners on the same element.
  target.addEventListener("pointerdown", onPointerDown, { signal, capture: true });
  target.addEventListener("pointermove", onPointerMove, { signal, capture: true });
  target.addEventListener("pointerup", onPointerUp, { signal, capture: true });
  target.addEventListener("pointercancel", onPointerCancel, { signal, capture: true });
  target.addEventListener("lostpointercapture", onPointerCancel, { signal, capture: true });

  return () => {
    abortController.abort();
    if (drag !== undefined) target.releasePointerCapture?.(drag.pointerId);
    drag = undefined;
    if (arrowRafId !== undefined) cancelAnimationFrame(arrowRafId);
    arrowRafId = undefined;
    store.getState().setPickerActive(false);
    store.getState().setPickerHover("none");
  };
}
