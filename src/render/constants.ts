// Fixed clear color + ortho frustum shared by every render scene so worker and main-thread
// renders are bit-comparable — the parity test diffs the resulting pixels. Values are arbitrary
// but must stay stable.
export const BACKGROUND_COLOR = 0x101820;
export const FRUSTUM = { left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 10 } as const;
// Raymarch step fraction while a camera gesture is live (setInteracting): ~0.4 keeps the volume
// readable mid-drag at ~2.5× the frame headroom; the settle repaint restores full quality.
export const INTERACTION_STEP_SCALE = 0.4;
// Drawing-buffer scale while a gesture is live: raymarch cost is per physical pixel, so 0.7²≈0.49×
// pixel work stacks with the step scale (~5× cheaper gesture frames). Readback stays full-res.
export const INTERACTION_RENDER_SCALE = 0.7;
