import { horizontalDragAllowed, type MarkerPart, verticalDragAllowed } from "@schema/marker.ts";
import type { Vec3 } from "@schema/types.ts";
import {
  clampToBox,
  cursorRay,
  dragAlongAxis,
  dragOnPlane,
  markerHandlePositions,
  type SimulationStore,
  unitBoxChordMidpoint,
  worldToScreen,
} from "@store";
import type { Disposer } from "./controls/index.ts";

// Point-picker pointer input on the main-thread canvas. Capture-phase, so it runs before
// pointerCamera's bubble-phase handlers on the same element: a pointerdown that grabs the marker (or a
// handle) calls stopImmediatePropagation so the camera never orbits; everything else falls through to
// pointerCamera unchanged. The marker lives in the worker, so we hit-test by projecting its world
// position (store/marker.worldToScreen) and solve drags with the pure pose-driven ray math, then
// dispatch store intents (setPickerPoint / setPickerActive / setPickerHover / requestPick). ui → store
// only — no render import.
//
// Gestures (magviz parity): drag the sphere to move it on the equatorial plane (Shift, or a steep
// view, switches to vertical-z); the ↕/↔ handles drag along a single axis; a tap on empty volume
// places the marker at the opacity-weighted pick (purpose "place"); double-click is left to
// pointerCamera (purpose "focus"). All inert while the marker is hidden (overlay.showPicker false).

const TAP_PX = 4; // pointer travel below this counts as a tap (placement), not an orbit
const CORE_HIT_PX = 22; // cursor→core-center radius that grabs the sphere
const HANDLE_HIT_PX = 16; // cursor→handle-stem distance that grabs a handle

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

function distToSegment(p: ClientPoint, a: ClientPoint, b: ClientPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function installPointerPicker(target: HTMLElement, store: SimulationStore): Disposer {
  const ac = new AbortController();
  const { signal } = ac;
  let drag: ActiveDrag | undefined;
  // Start of the current primary-pointer press (for tap-vs-orbit at release); set on every left
  // pointerdown, claimed or not, so a release on empty volume can place the marker.
  let downAt: { pointerId: number; x: number; y: number; claimed: boolean } | undefined;

  const ndcOf = (clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } => ({
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: 1 - ((clientY - rect.top) / rect.height) * 2,
  });
  const clientOf = (ndcX: number, ndcY: number, rect: DOMRect): ClientPoint => ({
    x: rect.left + ((ndcX + 1) / 2) * rect.width,
    y: rect.top + ((1 - ndcY) / 2) * rect.height,
  });

  // Which marker part (if any) the cursor is over, in screen space. Core first (the inner region is a
  // free-plane grab), then the ↕/↔ handle stems/knobs (the outer affordances).
  const hitTest = (clientX: number, clientY: number, rect: DOMRect): MarkerPart => {
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
    if (Math.hypot(clientX - corePx.x, clientY - corePx.y) < CORE_HIT_PX) return "core";
    const handles = markerHandlePositions(cameraPose, pickerPoint, ortho);
    if (handles.vertical !== null) {
      const k = worldToScreen(cameraPose, handles.vertical, aspect, ortho);
      if (
        !k.behind &&
        distToSegment(cursor, corePx, clientOf(k.ndcX, k.ndcY, rect)) < HANDLE_HIT_PX
      ) {
        return "vertical";
      }
    }
    if (handles.horizontal !== null) {
      const k = worldToScreen(cameraPose, handles.horizontal.position, aspect, ortho);
      if (
        !k.behind &&
        distToSegment(cursor, corePx, clientOf(k.ndcX, k.ndcY, rect)) < HANDLE_HIT_PX
      ) {
        return "horizontal";
      }
    }
    return "none";
  };

  // Build the drag mode for the grabbed part: handles + Shift lock to a single axis, a steep view
  // forces vertical, the equatorial regime drags on a screen-facing vertical plane, and the common
  // mid-elevation core grab drags on the horizontal (xy) plane at the marker's height.
  const buildMode = (part: MarkerPart, point: Vec3, shift: boolean): DragMode => {
    const { cameraPose, projection } = store.getState();
    const ortho = projection === "orthographic";
    if (part === "vertical") return { kind: "axis", origin: point, dir: [0, 0, 1] };
    if (part === "horizontal") {
      const axis = markerHandlePositions(cameraPose, point, ortho).horizontal?.axis ?? "x";
      return { kind: "axis", origin: point, dir: axis === "y" ? [0, 1, 0] : [1, 0, 0] };
    }
    if (shift && verticalDragAllowed(cameraPose))
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
    const aspect = rect.width / rect.height;
    if (mode.kind === "plane") {
      return dragOnPlane(cameraPose, ndcX, ndcY, aspect, ortho, mode.planePoint, mode.normal);
    }
    return dragAlongAxis(cameraPose, ndcX, ndcY, aspect, ortho, mode.origin, mode.dir);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) return; // primary left-button only; rest → camera
    const rect = target.getBoundingClientRect();
    const part = hitTest(event.clientX, event.clientY, rect);
    downAt = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      claimed: part !== "none",
    };
    if (part === "none") return; // not on the marker — let the event reach pointerCamera (orbit/pan)

    // Claim the marker interaction: the camera must not orbit. stopImmediatePropagation (not
    // preventDefault) so the native dblclick still reaches pointerCamera for focus.
    event.stopImmediatePropagation();
    target.setPointerCapture?.(event.pointerId);
    const point = store.getState().pickerPoint;
    if (point === null) return;
    const mode = buildMode(part, point, event.shiftKey);
    const ndc = ndcOf(event.clientX, event.clientY, rect);
    const grab = solve(mode, ndc.x, ndc.y, rect);
    const grabOffset: Vec3 =
      grab !== null ? [grab[0] - point[0], grab[1] - point[1], grab[2] - point[2]] : [0, 0, 0];
    drag = { pointerId: event.pointerId, mode, grabOffset, part, rect };
    store.getState().setPickerHover(part);
    store.getState().setPickerActive(true);
    target.style.cursor = "grabbing";
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (drag !== undefined && event.pointerId === drag.pointerId) {
      event.stopImmediatePropagation();
      const ndc = ndcOf(event.clientX, event.clientY, drag.rect);
      const hit = solve(drag.mode, ndc.x, ndc.y, drag.rect);
      if (hit === null) return; // grazing plane — keep the marker put
      store
        .getState()
        .setPickerPoint(
          clampToBox([
            hit[0] - drag.grabOffset[0],
            hit[1] - drag.grabOffset[1],
            hit[2] - drag.grabOffset[2],
          ]),
        );
      return;
    }
    if (event.buttons !== 0) return; // a camera drag owns the gesture — don't fight its cursor/hover
    const rect = target.getBoundingClientRect();
    const part = hitTest(event.clientX, event.clientY, rect);
    store.getState().setPickerHover(part);
    target.style.cursor = part === "none" ? "grab" : "pointer";
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (drag !== undefined && event.pointerId === drag.pointerId) {
      event.stopImmediatePropagation();
      target.releasePointerCapture?.(event.pointerId);
      drag = undefined;
      store.getState().setPickerActive(false);
      target.style.cursor = "grab";
      downAt = undefined;
      return;
    }
    // Tap on empty volume (not a marker grab, negligible travel) → place the marker at the cursor's
    // opacity-weighted pick. The double-click that may follow rides pointerCamera (purpose "focus").
    const pending = downAt;
    downAt = undefined;
    if (pending === undefined || pending.pointerId !== event.pointerId || pending.claimed) return;
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > TAP_PX) return;
    const { overlay, cameraPose, projection } = store.getState();
    if (!overlay.showPicker) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndc = ndcOf(event.clientX, event.clientY, rect);
    const aspect = rect.width / rect.height;
    const ray = cursorRay(cameraPose, ndc.x, ndc.y, aspect, projection === "orthographic");
    if (unitBoxChordMidpoint(ray.origin, ray.dir) === null) return; // tapped off the box — ignore
    store.getState().requestPick({ ndcX: ndc.x, ndcY: ndc.y, aspect, purpose: "place" });
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    target.releasePointerCapture?.(event.pointerId);
    drag = undefined;
    downAt = undefined;
    store.getState().setPickerActive(false);
    target.style.cursor = "grab";
  };

  // Capture phase so these run before pointerCamera's bubble-phase listeners on the same element.
  target.addEventListener("pointerdown", onPointerDown, { signal, capture: true });
  target.addEventListener("pointermove", onPointerMove, { signal, capture: true });
  target.addEventListener("pointerup", onPointerUp, { signal, capture: true });
  target.addEventListener("pointercancel", onPointerCancel, { signal, capture: true });
  target.addEventListener("lostpointercapture", onPointerCancel, { signal, capture: true });

  return () => {
    ac.abort();
    if (drag !== undefined) target.releasePointerCapture?.(drag.pointerId);
    drag = undefined;
    downAt = undefined;
    store.getState().setPickerActive(false);
    store.getState().setPickerHover("none");
  };
}
