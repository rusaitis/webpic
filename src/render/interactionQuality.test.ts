import { describe, expect, it } from "vitest";
import { INTERACTION_RENDER_SCALE, INTERACTION_STEP_SCALE } from "./constants.ts";
import {
  advanceSettling,
  beginInteracting,
  endInteracting,
  QUALITY_FULL,
  qualityLevel,
} from "./interactionQuality.ts";

describe("interaction quality state machine", () => {
  it("full is full quality at both scales", () => {
    expect(qualityLevel(QUALITY_FULL)).toEqual({ stepScale: 1, renderScale: 1 });
  });

  it("interacting drops both the march and the render scale", () => {
    expect(qualityLevel(beginInteracting())).toEqual({
      stepScale: INTERACTION_STEP_SCALE,
      renderScale: INTERACTION_RENDER_SCALE,
    });
  });

  it("ending a gesture enters the settle ramp: render restores first, steps ramp", () => {
    const settling = endInteracting(beginInteracting());
    expect(settling.kind).toBe("settling");
    const level = qualityLevel(settling);
    expect(level.renderScale).toBe(1); // resolution snaps back on the first settle frame
    expect(level.stepScale).toBeGreaterThan(INTERACTION_STEP_SCALE);
    expect(level.stepScale).toBeLessThan(1); // ...while step density ramps
  });

  it("the ramp lands at full and stays there", () => {
    let state = endInteracting(beginInteracting());
    for (let i = 0; i < 10 && state.kind !== "full"; i++) state = advanceSettling(state);
    expect(state).toBe(QUALITY_FULL);
    expect(advanceSettling(state)).toBe(QUALITY_FULL); // advancing full is a no-op
  });

  it("step scales are monotone non-decreasing along the ramp", () => {
    let state = endInteracting(beginInteracting());
    let prev = INTERACTION_STEP_SCALE;
    for (let i = 0; i < 10 && state.kind !== "full"; i++) {
      const { stepScale } = qualityLevel(state);
      expect(stepScale).toBeGreaterThanOrEqual(prev);
      prev = stepScale;
      state = advanceSettling(state);
    }
  });

  it("ending while not interacting changes nothing (idempotent edges)", () => {
    expect(endInteracting(QUALITY_FULL)).toBe(QUALITY_FULL);
    const settling = endInteracting(beginInteracting());
    expect(endInteracting(settling)).toBe(settling); // a repeated false edge can't restart the ramp
  });
});
