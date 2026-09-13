export { installPointerCamera } from "./camera/pointerCamera.ts";
// `Disposer` is the only control name app needs; the rest are intra-ui (../controls/index.ts).
export type { Disposer } from "./controls/types.ts";
export { installUi } from "./install.ts";
export { installPointerPicker } from "./picking/pointerPicker.ts";
export { installPointerSeedPlacer } from "./picking/pointerSeedPlacer.ts";
// The one LIFO disposer collector (CLAUDE.md §Lifecycle & shape) — app's bootstrap uses it too.
export { createSubscriptions } from "./subscriptions.ts";
export { applyUiVars } from "./theme/styles.ts";
