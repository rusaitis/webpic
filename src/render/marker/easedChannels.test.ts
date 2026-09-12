import { describe, expect, it } from "vitest";
import { createEasedChannels, easeStep } from "./easedChannels.ts";

const FRAME = 1 / 60;

describe("easeStep", () => {
  it("approaches but never reaches 1 within a frame", () => {
    const step = easeStep(FRAME, 14);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(1);
  });

  it("takes the same fraction of the remaining distance regardless of frame split", () => {
    // Two half-frames at the same rate must land where one whole frame does — that is what makes
    // the feel identical at 30 and 120 fps.
    const whole = easeStep(FRAME, 14);
    const half = easeStep(FRAME / 2, 14);
    expect(1 - (1 - half) * (1 - half)).toBeCloseTo(whole, 12);
  });

  it("is zero for a zero-length frame", () => {
    expect(easeStep(0, 14)).toBe(0);
  });
});

describe("createEasedChannels", () => {
  it("starts each channel at its declared initial value", () => {
    const eased = createEasedChannels({ gate: { rate: 14, initial: 1 }, hover: { rate: 14 } });
    expect(eased.get("gate")).toBe(1);
    expect(eased.get("hover")).toBe(0);
  });

  it("reports settled when every channel already sits on its target", () => {
    const eased = createEasedChannels({ hover: { rate: 14 } });
    expect(eased.advance(FRAME)).toBe(false);
  });

  it("moves a channel toward a new target without overshooting it", () => {
    const eased = createEasedChannels({ hover: { rate: 14 } });
    eased.setTarget("hover", 1);
    eased.advance(FRAME);
    expect(eased.get("hover")).toBeGreaterThan(0);
    expect(eased.get("hover")).toBeLessThan(1);
  });

  it("keeps reporting motion until the channel is within the settle epsilon", () => {
    const eased = createEasedChannels({ hover: { rate: 14 } });
    eased.setTarget("hover", 1);
    let frames = 0;
    while (eased.advance(FRAME) && frames < 1000) frames++;
    expect(frames).toBeGreaterThan(1); // it eases, not snaps
    expect(frames).toBeLessThan(1000); // and it does settle
    expect(eased.get("hover")).toBeCloseTo(1, 2);
  });

  it("settles faster at a higher rate", () => {
    const framesTo = (rate: number): number => {
      const eased = createEasedChannels({ hover: { rate } });
      eased.setTarget("hover", 1);
      let frames = 0;
      while (eased.advance(FRAME) && frames < 1000) frames++;
      return frames;
    };
    expect(framesTo(20)).toBeLessThan(framesTo(5));
  });

  it("decays a spike back to a target it never left", () => {
    const eased = createEasedChannels({ pulse: { rate: 7 } });
    eased.spike("pulse", 1);
    expect(eased.get("pulse")).toBe(1);
    eased.advance(FRAME);
    expect(eased.get("pulse")).toBeLessThan(1);
    while (eased.advance(FRAME));
    expect(eased.get("pulse")).toBeCloseTo(0, 2);
  });

  it("advances every channel on one call, and reports motion while any is moving", () => {
    const eased = createEasedChannels({ a: { rate: 20 }, b: { rate: 2 } });
    eased.setTarget("a", 1);
    eased.setTarget("b", 1);
    while (eased.advance(FRAME)) {
      // b is the slow one, so the loop cannot exit while it is still climbing.
    }
    expect(eased.get("a")).toBeCloseTo(1, 2);
    expect(eased.get("b")).toBeCloseTo(1, 2);
  });

  it("retargets mid-flight without jumping", () => {
    const eased = createEasedChannels({ hover: { rate: 14 } });
    eased.setTarget("hover", 1);
    for (let i = 0; i < 5; i++) eased.advance(FRAME);
    const midFlight = eased.get("hover");
    eased.setTarget("hover", 0);
    eased.advance(FRAME);
    expect(eased.get("hover")).toBeLessThan(midFlight);
    expect(eased.get("hover")).toBeGreaterThan(0);
  });
});
