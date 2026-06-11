import type { CameraMotion } from "@schema/camera.ts";
import { INTERACTION_RENDER_SCALE, INTERACTION_STEP_SCALE } from "./constants.ts";

// Camera-motion quality as a pure state machine: coarse while a gesture is live, a gentler
// "animating" tier while a machine-driven fly runs (predictable + short — it should look good),
// then a short settle ramp instead of a one-frame pop back to full quality. The worker owns the
// wiring (apply levels to scenes/renderer, advance once per painted frame); the transitions live
// here so they are Node-testable.

export interface QualityLevel {
  readonly stepScale: number;
  readonly renderScale: number;
}

export type QualityState =
  | { readonly kind: "full" }
  | { readonly kind: "interacting" }
  | { readonly kind: "animating" }
  | { readonly kind: "settling"; readonly step: number };

export const QUALITY_FULL: QualityState = { kind: "full" };

// The fly tier marches mildly coarser at full resolution — no render-target realloc on the fly's
// edges, and the post-fly settle is at most one subtle step-density change.
const ANIMATING_STEP_SCALE = 0.7;

// Step-scale ramp painted after a gesture ends, one dirty frame per entry, then full. Render scale
// restores in one step at the first settle frame — the visible pop is step density, not resolution,
// and a single restore costs one render-target realloc per gesture instead of one per ramp entry.
// Sharing ANIMATING_STEP_SCALE pins the fly-end invariant: animating → settling changes nothing.
const SETTLE_STEP_SCALES: readonly number[] = [ANIMATING_STEP_SCALE];

const INTERACTING: QualityState = { kind: "interacting" };
const ANIMATING: QualityState = { kind: "animating" };

// Same-state inputs return the same reference so the worker's level diffing stays cheap.
export function applyCameraMotion(state: QualityState, motion: CameraMotion): QualityState {
  switch (motion) {
    case "gesture":
      return state.kind === "interacting" ? state : INTERACTING;
    case "fly":
      return state.kind === "animating" ? state : ANIMATING;
    case "idle":
      return state.kind === "interacting" || state.kind === "animating"
        ? { kind: "settling", step: 0 }
        : state;
  }
}

export function advanceSettling(state: QualityState): QualityState {
  if (state.kind !== "settling") return state;
  const next = state.step + 1;
  return next >= SETTLE_STEP_SCALES.length ? QUALITY_FULL : { kind: "settling", step: next };
}

export function qualityLevel(state: QualityState): QualityLevel {
  switch (state.kind) {
    case "full":
      return { stepScale: 1, renderScale: 1 };
    case "interacting":
      return { stepScale: INTERACTION_STEP_SCALE, renderScale: INTERACTION_RENDER_SCALE };
    case "animating":
      return { stepScale: ANIMATING_STEP_SCALE, renderScale: 1 };
    case "settling":
      return { stepScale: SETTLE_STEP_SCALES[state.step] ?? 1, renderScale: 1 };
  }
}
