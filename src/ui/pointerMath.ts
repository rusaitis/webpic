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
