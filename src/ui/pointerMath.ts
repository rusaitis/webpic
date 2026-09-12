// Client (CSS-pixel) pointer coordinates → normalized device coordinates for a canvas rect: x,y in
// [-1, 1] with y flipped (screen-down → NDC-up). This is the convention worldToScreen and the
// dolly/focus/marker-drag math all expect, so it lives in one place — a stray sign on the y-flip in
// any one copy would be a subtle, hard-to-spot bug.
export function clientToNdc(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): { x: number; y: number } {
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: 1 - ((clientY - rect.top) / rect.height) * 2,
  };
}

// The inverse, for placing screen affordances on a world point the renderer reported in NDC (the
// marker handles). Same y-flip, same one place — see above.
export function ndcToClient(ndcX: number, ndcY: number, rect: DOMRect): { x: number; y: number } {
  return {
    x: rect.left + ((ndcX + 1) / 2) * rect.width,
    y: rect.top + ((1 - ndcY) / 2) * rect.height,
  };
}

const NOMINAL_FRAME_MS = 1000 / 60;
const MAX_FRAME_DT_MS = 100;

// rAF frame delta in ms, clamped: the first frame (no prior timestamp) reports a nominal 60 fps step,
// and a background-tab resume that hands rAF a huge dt is clamped so an eased loop glides instead of
// teleporting. Shared by the camera glide (cameraGlide) and the marker arrow-slide (pointerPicker).
export function frameDt(lastMs: number | undefined, nowMs: number): number {
  return lastMs === undefined ? NOMINAL_FRAME_MS : Math.min(nowMs - lastMs, MAX_FRAME_DT_MS);
}

// Collapse a burst of triggers (resize, ResizeObserver, a settle chain) into one call on the next
// frame. Returns a no-op when the element is detached — no view, no rAF, nothing to schedule.
export function coalesceFrame(view: Window | null, run: () => void): () => void {
  let isScheduled = false;
  return () => {
    if (isScheduled || view === null) return;
    isScheduled = true;
    view.requestAnimationFrame(() => {
      isScheduled = false;
      run();
    });
  };
}
