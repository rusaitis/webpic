import type { CameraMotion } from "@schema/camera.ts";
import { createFrameGovernor } from "./frameGovernor.ts";
import {
  advanceSettling as advanceSettleStep,
  applyCameraMotion,
  QUALITY_FULL,
  type QualityLevel,
  type QualityState,
  qualityLevel,
} from "./interactionQuality.ts";

// The camera-motion quality tier (full → interacting → animating → settling) wired to the scenes +
// swapchain. It owns the live QualityState + the applied-level cache and drives the pure transitions
// in interactionQuality.ts; the worker holds the machine through this seam so the render loop
// (advanceSettling, once per painted frame) and device-restore (resyncAfterRebuild) talk to a stable
// API instead of raw module state. Levels apply through the host — the per-layer step scale (the
// registry) and the swapchain render scale (the renderer) — and only a real level change kicks a
// repaint, so a no-op transition (same-reference per interactionQuality) costs nothing.
export interface QualityHost {
  /** Is the display loop live? When false (Node one-shot) a settle ramp collapses straight to full. */
  hasLoop(): boolean;
  /** Push the interaction step scale to every volume scene (registry.applyStepScale). */
  applyStepScale(stepScale: number): void;
  /** Set the swapchain drawing-buffer scale (renderer.setRenderScale). */
  setRenderScale(scale: number): void;
  requestRender(): void;
}

export interface QualityController {
  /** A camera-motion edge (gesture/fly/idle): transition, apply the level, arm the settle ramp. */
  setMotion(motion: CameraMotion): void;
  /** Advance a live settle ramp one level — the loop calls this once per painted frame. */
  advanceSettling(): void;
  /** Feed the frame-time governor one painted-frame interval; a tier change re-folds renderScale. */
  sampleFrameInterval(intervalMs: number): void;
  /** The governor's current render-scale ceiling (1 = unthrottled) — surfaced in the perf HUD. */
  governorScale(): number;
  /** The current per-layer step scale (the registry reads it for freshly built scenes). */
  stepScale(): number;
  /** Re-assert the live level on a fresh device, whose renderer restarts at scale 1. */
  resyncAfterRebuild(): void;
}

export function createQualityController(host: QualityHost): QualityController {
  let state: QualityState = QUALITY_FULL;
  let appliedLevel: QualityLevel = qualityLevel(QUALITY_FULL);
  // The frame-time governor caps renderScale under sustained slow frames (thermal throttle / heavy
  // view) and restores it on recovery — orthogonal to the motion tier, folded in as a multiplier.
  const governor = createFrameGovernor();

  // Diff the *effective* level (motion tier, with the governor's ceiling multiplied into renderScale)
  // against the applied cache, push only what changed, repaint on any change.
  function apply(): void {
    const level = qualityLevel(state);
    const renderScale = level.renderScale * governor.scale();
    let changed = false;
    if (level.stepScale !== appliedLevel.stepScale) {
      host.applyStepScale(level.stepScale);
      changed = true;
    }
    if (renderScale !== appliedLevel.renderScale) {
      host.setRenderScale(renderScale);
      changed = true;
    }
    appliedLevel = { stepScale: level.stepScale, renderScale };
    if (changed) host.requestRender();
  }

  return {
    setMotion(motion) {
      state = applyCameraMotion(state, motion);
      // No display loop (Node) means nothing advances a settle ramp — collapse straight to full so
      // the synchronous one-shot paints land at final quality.
      if (!host.hasLoop() && state.kind === "settling") state = QUALITY_FULL;
      apply();
      // animating → settling step 0 is level-identical, so apply posts no repaint — but the ramp only
      // advances after a *painted* frame; without this kick it would stall at the first level forever.
      if (state.kind === "settling") host.requestRender();
    },
    advanceSettling() {
      if (state.kind !== "settling") return;
      state = advanceSettleStep(state);
      apply();
    },
    sampleFrameInterval(intervalMs) {
      if (governor.sample(intervalMs)) apply(); // a tier change re-folds the renderScale ceiling
    },
    governorScale() {
      return governor.scale();
    },
    stepScale() {
      return qualityLevel(state).stepScale;
    },
    resyncAfterRebuild() {
      appliedLevel = { stepScale: qualityLevel(state).stepScale, renderScale: 1 };
      apply();
    },
  };
}
