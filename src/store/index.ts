// The store layer's whole surface: ui and app consume it through this barrel and never deep-import,
// so a module is here or it is store-internal. Wholesale re-export rather than a named list — the
// interaction math alone is 40-odd pure functions, and knip reports any that nothing consumes.
// The root holds the three zustand stores and the machinery around them; `intents/` is the pure ops
// they compose (framework-free, node-testable) and `interaction/` the pointer/pose math.

export * from "./intents/layers.ts";
export * from "./intents/overlay.ts";
export * from "./interaction/camera.ts";
export * from "./interaction/marker.ts";
export * from "./interaction/picker.ts";
export * from "./interaction/seedPick.ts";
export * from "./layerKinds.ts";
export * from "./perf.ts";
export * from "./simulationStore.ts";
export * from "./ui.ts";
