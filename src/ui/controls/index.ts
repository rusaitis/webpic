// The owned control facade, re-exported by the layer barrel (@ui) because app and embedders build
// panes with it. No other ui subfolder has a barrel: they are deep-imported by their siblings, and
// app's one deep import (the lazily chunked perf HUD) wants to stay out of the barrel's graph.
export { createPane } from "./pane.ts";
export { createPopover } from "./popover.ts";
export { intervalToWindow, windowToInterval } from "./rangeMath.ts";
export type {
  ControlHandle,
  Disposer,
  NoteHandle,
  Pane,
  RangeValue,
  SelectChoice,
  SelectHandle,
} from "./types.ts";
