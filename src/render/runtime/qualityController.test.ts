import { describe, expect, it, vi } from "vitest";
import { INTERACTION_RENDER_SCALE, INTERACTION_STEP_SCALE } from "../constants.ts";
import { GOVERNOR_SCALES } from "./frameGovernor.ts";
import { createQualityController } from "./qualityController.ts";

// The controller in isolation: a fake host records every level push (step scale → scenes, render
// scale → swapchain) and repaint, with a togglable loop. These pin the same contracts the through-
// the-worker suites assert (worker.quality with a live loop, worker.streaming's Node collapse),
// minus the rAF + renderer machinery.
function harness({ hasLoop = true }: { hasLoop?: boolean } = {}) {
  const stepScales: number[] = [];
  const renderScales: number[] = [];
  const applyStepScale = vi.fn((s: number) => stepScales.push(s));
  const setRenderScale = vi.fn((s: number) => renderScales.push(s));
  const requestRender = vi.fn();
  let loop = hasLoop;
  const quality = createQualityController({
    hasLoop: () => loop,
    applyStepScale,
    setRenderScale,
    requestRender,
  });
  return {
    quality,
    stepScales,
    applyStepScale,
    setRenderScale,
    requestRender,
    setLoop: (v: boolean) => {
      loop = v;
    },
  };
}

describe("createQualityController", () => {
  it("a gesture marches coarser and shrinks the swapchain", () => {
    const h = harness();
    h.quality.setMotion("gesture");
    expect(h.applyStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE);
    expect(h.setRenderScale).toHaveBeenCalledWith(INTERACTION_RENDER_SCALE);
    expect(h.quality.stepScale()).toBe(INTERACTION_STEP_SCALE);
  });

  it("a fly marches coarser at full resolution — no render-scale realloc", () => {
    const h = harness();
    h.quality.setMotion("fly");
    expect(h.applyStepScale).toHaveBeenCalledWith(0.7);
    expect(h.setRenderScale).not.toHaveBeenCalled();
  });

  it("with a live loop, idle arms the settle ramp at 0.7, not a one-frame pop to full", () => {
    const h = harness({ hasLoop: true });
    h.quality.setMotion("gesture");
    h.applyStepScale.mockClear();
    h.setRenderScale.mockClear();
    h.requestRender.mockClear();

    h.quality.setMotion("idle");
    // Render scale restores in one step; step density holds at the settle level, not full.
    expect(h.setRenderScale).toHaveBeenCalledWith(1);
    expect(h.applyStepScale).toHaveBeenCalledWith(0.7);
    expect(h.applyStepScale).not.toHaveBeenCalledWith(1);
    // The settle kick must fire so a painted frame can advance the ramp (else it stalls at 0.7).
    expect(h.requestRender).toHaveBeenCalled();

    h.applyStepScale.mockClear();
    h.quality.advanceSettling(); // one painted frame → full
    expect(h.applyStepScale).toHaveBeenCalledWith(1);
    expect(h.quality.stepScale()).toBe(1);
  });

  it("without a loop (Node one-shot), idle collapses straight to full", () => {
    const h = harness({ hasLoop: false });
    h.quality.setMotion("gesture");
    h.applyStepScale.mockClear();
    h.setRenderScale.mockClear();

    h.quality.setMotion("idle");
    expect(h.applyStepScale).toHaveBeenCalledWith(1);
    expect(h.applyStepScale).not.toHaveBeenCalledWith(0.7);
    expect(h.setRenderScale).toHaveBeenCalledWith(1);
  });

  it("the full restore sequence over painted frames is 0.4 → 0.7 → 1", () => {
    const h = harness({ hasLoop: true });
    h.quality.setMotion("gesture");
    h.quality.setMotion("idle");
    h.quality.advanceSettling();
    expect(h.stepScales).toEqual([INTERACTION_STEP_SCALE, 0.7, 1]);
  });

  it("advanceSettling is a no-op outside a settle ramp", () => {
    const h = harness();
    h.quality.setMotion("gesture"); // interacting, not settling
    h.applyStepScale.mockClear();
    h.quality.advanceSettling();
    expect(h.applyStepScale).not.toHaveBeenCalled();
  });

  it("a same-tier transition posts nothing (cheap reference diff)", () => {
    const h = harness();
    h.quality.setMotion("gesture");
    h.applyStepScale.mockClear();
    h.setRenderScale.mockClear();
    h.requestRender.mockClear();
    h.quality.setMotion("gesture"); // identical state
    expect(h.applyStepScale).not.toHaveBeenCalled();
    expect(h.setRenderScale).not.toHaveBeenCalled();
    expect(h.requestRender).not.toHaveBeenCalled();
  });

  it("resyncAfterRebuild re-shrinks the fresh renderer when a gesture is live across a restore", () => {
    const h = harness();
    h.quality.setMotion("gesture"); // interacting: step 0.4, render 0.7
    h.applyStepScale.mockClear();
    h.setRenderScale.mockClear();
    // Fresh device: the rebuilt scenes already carry 0.4, but the new renderer starts at scale 1.
    h.quality.resyncAfterRebuild();
    expect(h.applyStepScale).not.toHaveBeenCalled(); // step scale already correct on the scenes
    expect(h.setRenderScale).toHaveBeenCalledWith(INTERACTION_RENDER_SCALE); // re-applied to the swapchain
  });

  it("the frame governor lowers the idle render-scale ceiling under sustained slow frames", () => {
    const h = harness();
    h.setRenderScale.mockClear();
    h.applyStepScale.mockClear();
    h.requestRender.mockClear();
    // Sustained ~20 fps at idle (full tier renderScale 1): the governor sinks its ceiling to the floor.
    for (let i = 0; i < 200; i++) h.quality.sampleFrameInterval(50);
    expect(h.setRenderScale).toHaveBeenLastCalledWith(GOVERNOR_SCALES.at(-1));
    expect(h.requestRender).toHaveBeenCalled(); // a ceiling drop repaints
    expect(h.applyStepScale).not.toHaveBeenCalled(); // it scales resolution, never step density
  });

  it("the governor ceiling multiplies into the interaction tier, not just idle", () => {
    const h = harness();
    for (let i = 0; i < 40; i++) h.quality.sampleFrameInterval(50); // trip down one tier
    const tier = GOVERNOR_SCALES[1] ?? 1;
    h.setRenderScale.mockClear();
    h.quality.setMotion("gesture"); // interaction renderScale 0.7 × the governor ceiling
    expect(h.setRenderScale).toHaveBeenLastCalledWith(
      expect.closeTo(INTERACTION_RENDER_SCALE * tier, 6),
    );
  });
});
