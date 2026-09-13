import { dollyPose, dollyPoseToCursor, type SimulationStore } from "@store";
import { clientToNdc } from "../pointerMath.ts";

// Dolly anchored at a client point — the one thing the two-finger pinch and the wheel/Safari-pinch
// path share. Each measures its own rect (a live gesture rect, a cached wheel trail rect); only the
// anchoring is common. A target with no layout falls back to a plain dolly, since there is no cursor
// to anchor to.
export function dollyAtPoint(
  store: SimulationStore,
  delta: number,
  clientX: number,
  clientY: number,
  rect: DOMRect,
): void {
  const { cameraPose, setCameraPose } = store.getState();
  if (rect.width <= 0 || rect.height <= 0) {
    setCameraPose(dollyPose(cameraPose, delta));
    return;
  }
  const { x: ndcX, y: ndcY } = clientToNdc(clientX, clientY, rect); // screen up = +ndcY
  setCameraPose(dollyPoseToCursor(cameraPose, delta, ndcX, ndcY, rect.width / rect.height));
}
