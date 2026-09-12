// The lifecycle face every managed render subsystem presents to the worker: the layer registry, the
// axes/grid overlay, the point-picker marker — and the field-line / particle scenes to come. The
// worker holds these as a `RenderModule[]` so the device-restore sequence and final teardown iterate
// one list instead of naming each manager, and adding a renderable is one array entry, not edits
// scattered across the recovery host. The array ORDER is the load-bearing recovery order (see
// deviceRecovery.ts): supersede every in-flight warm, drop the dead resources, then rebuild — only
// then warm + repaint. Each manager keeps its own retained CPU source so a rebuild reproduces the
// live scene on the fresh device; a module owns no three/renderer handle (the worker does).
export interface RenderModule {
  // Bump the scene epoch(s) so a warm-then-commit racing a device loss discards instead of landing
  // its scene on the dead device.
  supersedeWarms(): void;
  // Best-effort drop of the dead device's GPU handles, keeping the retained CPU source for replay
  // (teardown on a lost device can throw — the worker swallows it).
  disposeForRebuild(): void;
  // Replay the scene(s) from the retained source on the freshly installed device.
  rebuild(): void;
  // Full teardown (worker dispose).
  dispose(): void;
}

// The seams every manager reaches back through, regardless of its domain: repaint and fault-report.
// Passed once instead of restated in each manager's host (domain-specific callbacks — `warmComposite`,
// the marker's live `pose()` — stay on the per-manager host).
export interface RenderModuleContext {
  requestRender(): void;
  reportFault(error: unknown): void;
}
