// Fixed clear color + ortho frustum shared by every render scene so worker and main-thread
// renders are bit-comparable — the parity test diffs the resulting pixels. Values are arbitrary
// but must stay stable.
export const BACKGROUND_COLOR = 0x101820;
export const FRUSTUM = { left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 10 } as const;
