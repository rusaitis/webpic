import { describe, expect, it } from "vitest";
import { createTapRecognizer, createTwistGate } from "./gestureRecognizers.ts";

// A steady pinch-zoom: spread grows, angle holds. Twist travel stays at zero.
function zoomOnly(gate: ReturnType<typeof createTwistGate>, steps: number): boolean {
  let engaged = false;
  for (let i = 0; i < steps; i++) engaged = gate.advance(0, 200, 10);
  return engaged;
}

describe("createTwistGate", () => {
  it("stays disengaged through a pinch-zoom that never rotates", () => {
    expect(zoomOnly(createTwistGate(), 40)).toBe(false);
  });

  it("stays disengaged while a wobble's arc is outweighed by the zoom travel", () => {
    const gate = createTwistGate();
    // 0.02 rad at a 200 px spread is 4 px of arc per step against 20 px of zoom.
    let engaged = false;
    for (let i = 0; i < 40; i++) engaged = gate.advance(0.02, 200, 20);
    expect(engaged).toBe(false);
  });

  it("engages once the twist arc clears the floor and outweighs the zoom", () => {
    const gate = createTwistGate();
    expect(gate.advance(0.1, 200, 0)).toBe(false); // 20 px of arc — under the 30 px floor
    expect(gate.advance(0.1, 200, 0)).toBe(true); // 40 px, and no zoom to outweigh it
  });

  it("stays engaged for the rest of the gesture once it opens", () => {
    const gate = createTwistGate();
    gate.advance(0.5, 200, 0);
    expect(gate.advance(0, 200, 100)).toBe(true); // a pure zoom no longer closes it
  });

  it("closes again on reset, so a fresh two-finger gesture re-earns the bank", () => {
    const gate = createTwistGate();
    gate.advance(0.5, 200, 0);
    gate.reset();
    expect(gate.advance(0, 200, 100)).toBe(false);
  });
});

const tap = (
  atMs: number,
  x = 0,
  y = 0,
): Parameters<ReturnType<typeof createTapRecognizer>["isDoubleTap"]>[0] => ({
  x,
  y,
  atMs,
  heldMs: 50,
  travelPx: 1,
  wasMultiTouch: false,
});

describe("createTapRecognizer", () => {
  it("reports a double tap for two quick presses in the same place", () => {
    const taps = createTapRecognizer();
    expect(taps.isDoubleTap(tap(0))).toBe(false);
    expect(taps.isDoubleTap(tap(150))).toBe(true);
  });

  it("consumes the pair, so a third tap starts a fresh chain", () => {
    const taps = createTapRecognizer();
    taps.isDoubleTap(tap(0));
    taps.isDoubleTap(tap(150));
    expect(taps.isDoubleTap(tap(200))).toBe(false);
  });

  it("does not pair two taps further apart than the double-tap window", () => {
    const taps = createTapRecognizer();
    taps.isDoubleTap(tap(0));
    expect(taps.isDoubleTap(tap(1000))).toBe(false);
  });

  it("does not pair two taps that land far apart on screen", () => {
    const taps = createTapRecognizer();
    taps.isDoubleTap(tap(0, 0, 0));
    expect(taps.isDoubleTap(tap(100, 200, 0))).toBe(false);
  });

  it("treats a press held too long as a drag, not a tap", () => {
    const taps = createTapRecognizer();
    taps.isDoubleTap(tap(0));
    expect(taps.isDoubleTap({ ...tap(100), heldMs: 900 })).toBe(false);
  });

  it("treats a press that travelled too far as a drag, not a tap", () => {
    const taps = createTapRecognizer();
    taps.isDoubleTap(tap(0));
    expect(taps.isDoubleTap({ ...tap(100), travelPx: 50 })).toBe(false);
  });

  it("never taps a release from a gesture that was ever a pinch", () => {
    const taps = createTapRecognizer();
    taps.isDoubleTap(tap(0));
    expect(taps.isDoubleTap({ ...tap(100), wasMultiTouch: true })).toBe(false);
  });

  it("breaks the chain, so the tap after an interruption cannot complete a pair", () => {
    const taps = createTapRecognizer();
    taps.isDoubleTap(tap(0));
    taps.breakChain();
    expect(taps.isDoubleTap(tap(100))).toBe(false);
  });

  it("rejects a non-tap and breaks the chain in the same call", () => {
    const taps = createTapRecognizer();
    taps.isDoubleTap(tap(0));
    expect(taps.isDoubleTap({ ...tap(100), travelPx: 99 })).toBe(false);
    expect(taps.isDoubleTap(tap(150))).toBe(false); // the drag consumed the chain
  });
});
