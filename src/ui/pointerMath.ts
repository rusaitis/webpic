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

const NOMINAL_FRAME_MS = 1000 / 60;
const MAX_FRAME_DT_MS = 100;

// rAF frame delta in ms, clamped: the first frame (no prior timestamp) reports a nominal 60 fps step,
// and a background-tab resume that hands rAF a huge dt is clamped so an eased loop glides instead of
// teleporting. Shared by the camera glide (cameraGlide) and the marker arrow-slide (pointerPicker).
export function frameDt(lastMs: number | undefined, nowMs: number): number {
  return lastMs === undefined ? NOMINAL_FRAME_MS : Math.min(nowMs - lastMs, MAX_FRAME_DT_MS);
}
