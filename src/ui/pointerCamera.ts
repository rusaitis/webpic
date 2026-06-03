import { dollyPose, orbitPose, panPose, type SimulationStore } from "@store";
import type { Disposer } from "./controls/index.ts";

// Pointer/wheel input on the main-thread canvas → camera-pose intents. The OffscreenCanvas is
// transferred to the worker, but the <canvas> element still receives DOM events here; we read the
// live pose from the store, nudge it via the pure helpers (store/camera), and dispatch
// setCameraPose. No render import — ui → store only. The worker's rAF loop coalesces a drag's many
// posts into one paint, so dispatching per pointermove (like the window/level drag) is cheap.

export function installPointerCamera(target: HTMLElement, store: SimulationStore): Disposer {
  const ac = new AbortController();
  const { signal } = ac;
  let dragging = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let activePointer: number | undefined;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return; // left orbits/pans, middle pans
    dragging = true;
    panning = event.shiftKey || event.button === 1;
    lastX = event.clientX;
    lastY = event.clientY;
    activePointer = event.pointerId;
    target.setPointerCapture?.(event.pointerId); // keep the drag if the cursor leaves the canvas
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (dx === 0 && dy === 0) return;
    const { cameraPose, setCameraPose } = store.getState();
    setCameraPose(panning ? panPose(cameraPose, dx, dy) : orbitPose(cameraPose, dx, dy));
  };

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    panning = false;
    if (activePointer !== undefined) {
      target.releasePointerCapture?.(activePointer);
      activePointer = undefined;
    }
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault(); // we own the gesture — don't let the page scroll
    const { cameraPose, setCameraPose } = store.getState();
    setCameraPose(dollyPose(cameraPose, event.deltaY));
  };

  target.addEventListener("pointerdown", onPointerDown, { signal });
  target.addEventListener("pointermove", onPointerMove, { signal });
  target.addEventListener("pointerup", endDrag, { signal });
  target.addEventListener("pointercancel", endDrag, { signal });
  target.addEventListener("lostpointercapture", endDrag, { signal });
  // Non-passive: preventDefault needs an explicitly non-passive listener (wheel defaults passive).
  target.addEventListener("wheel", onWheel, { passive: false, signal });

  const priorTouchAction = target.style.touchAction;
  target.style.touchAction = "none"; // touch-drag should orbit, not scroll the page

  return () => {
    ac.abort();
    endDrag();
    target.style.touchAction = priorTouchAction;
  };
}
