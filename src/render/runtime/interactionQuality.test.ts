import { describe, expect, it } from "vitest";
import { INTERACTION_RENDER_SCALE, INTERACTION_STEP_SCALE } from "../constants.ts";
import {
  advanceSettling,
  applyCameraMotion,
  QUALITY_FULL,
  type QualityState,
  qualityLevel,
} from "./interactionQuality.ts";

const interacting = (): QualityState => applyCameraMotion(QUALITY_FULL, "gesture");
const animating = (): QualityState => applyCameraMotion(QUALITY_FULL, "fly");

describe("camera-motion quality state machine", () => {
  it("full is full quality at both scales", () => {
    expect(qualityLevel(QUALITY_FULL)).toEqual({ stepScale: 1, renderScale: 1 });
  });

  it("a gesture drops both the march and the render scale", () => {
    expect(qualityLevel(interacting())).toEqual({
      stepScale: INTERACTION_STEP_SCALE,
      renderScale: INTERACTION_RENDER_SCALE,
    });
  });

  it("a fly runs the animating tier: mildly coarser march at full resolution", () => {
    expect(qualityLevel(animating())).toEqual({ stepScale: 0.7, renderScale: 1 });
  });

  it("the animating tier equals the settle ramp's first level (no pop at fly end)", () => {
    const settleFirst = applyCameraMotion(interacting(), "idle");
    expect(qualityLevel(animating())).toEqual(qualityLevel(settleFirst));
  });

  it("idle from a gesture enters the settle ramp: render restores first, steps ramp", () => {
    const settling = applyCameraMotion(interacting(), "idle");
    expect(settling.kind).toBe("settling");
    const level = qualityLevel(settling);
    expect(level.renderScale).toBe(1); // resolution snaps back on the first settle frame
    expect(level.stepScale).toBeGreaterThan(INTERACTION_STEP_SCALE);
    expect(level.stepScale).toBeLessThan(1); // ...while step density ramps
  });

  it("idle from a fly settles too (the painted-frame ramp restores full march)", () => {
    const settling = applyCameraMotion(animating(), "idle");
    expect(settling.kind).toBe("settling");
    expect(advanceSettling(settling)).toBe(QUALITY_FULL);
  });

  it("the ramp lands at full and stays there", () => {
    let state = applyCameraMotion(interacting(), "idle");
    for (let i = 0; i < 10 && state.kind !== "full"; i++) state = advanceSettling(state);
    expect(state).toBe(QUALITY_FULL);
    expect(advanceSettling(state)).toBe(QUALITY_FULL); // advancing full is a no-op
  });

  it("step scales are monotone non-decreasing along the ramp", () => {
    let state = applyCameraMotion(interacting(), "idle");
    let prev = INTERACTION_STEP_SCALE;
    for (let i = 0; i < 10 && state.kind !== "full"; i++) {
      const { stepScale } = qualityLevel(state);
      expect(stepScale).toBeGreaterThanOrEqual(prev);
      prev = stepScale;
      state = advanceSettling(state);
    }
  });

  it("a gesture outranks a fly in either order (hand on the camera wins)", () => {
    expect(applyCameraMotion(animating(), "gesture").kind).toBe("interacting");
    expect(applyCameraMotion(interacting(), "fly").kind).toBe("animating"); // drag released mid-fly
  });

  it("repeated same-motion inputs return the same reference (cheap level diffing)", () => {
    const a = interacting();
    expect(applyCameraMotion(a, "gesture")).toBe(a);
    const b = animating();
    expect(applyCameraMotion(b, "fly")).toBe(b);
  });

  it("idle while not moving changes nothing (idempotent edges)", () => {
    expect(applyCameraMotion(QUALITY_FULL, "idle")).toBe(QUALITY_FULL);
    const settling = applyCameraMotion(interacting(), "idle");
    expect(applyCameraMotion(settling, "idle")).toBe(settling); // a repeated idle can't restart the ramp
  });
});
