import { INTERACTION_RENDER_SCALE, INTERACTION_STEP_SCALE } from "./constants.ts";

// Interaction-time quality as a pure state machine: coarse while a gesture is live, then a short
// settle ramp instead of a one-frame pop back to full quality. The worker owns the wiring (apply
// levels to scenes/renderer, advance once per painted frame); the transitions live here so they
// are Node-testable.

export interface QualityLevel {
  readonly stepScale: number;
  readonly renderScale: number;
}

export type QualityState =
  | { readonly kind: "full" }
  | { readonly kind: "interacting" }
  | { readonly kind: "settling"; readonly step: number };

export const QUALITY_FULL: QualityState = { kind: "full" };

// Step-scale ramp painted after a gesture ends, one dirty frame per entry, then full. Render scale
// restores in one step at the first settle frame — the visible pop is step density, not resolution,
// and a single restore costs one render-target realloc per gesture instead of one per ramp entry.
const SETTLE_STEP_SCALES: readonly number[] = [0.7];

export function beginInteracting(): QualityState {
  return { kind: "interacting" };
}

export function endInteracting(state: QualityState): QualityState {
  return state.kind === "interacting" ? { kind: "settling", step: 0 } : state;
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
    case "settling":
      return { stepScale: SETTLE_STEP_SCALES[state.step] ?? 1, renderScale: 1 };
  }
}
