import { describe, expect, it } from "vitest";
import { type Box, chooseEdge, pushOutOf, type Viewport } from "./dragSnap.ts";

const VP: Viewport = { width: 1000, height: 800 };
const EDGE_GAP = 12;

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

describe("chooseEdge", () => {
  it("docks to the left edge with the left anchor", () => {
    const p = chooseEdge(box(10, 300, 24, 220), VP, undefined);
    expect(p.edge).toBe("left");
    expect(p.h).toBe("left");
    expect(p.left).toBe(EDGE_GAP);
    expect(p.top).toBe(300); // free axis preserved
  });

  it("docks to the right edge with the right anchor", () => {
    const p = chooseEdge(box(971, 300, 24, 220), VP, undefined);
    expect(p.edge).toBe("right");
    expect(p.h).toBe("right");
    expect(p.left).toBe(VP.width - 24 - EDGE_GAP);
  });

  it("docks a wide strip to the bottom edge (horizontal orientation)", () => {
    const p = chooseEdge(box(300, 770, 360, 24), VP, undefined);
    expect(p.edge).toBe("bottom");
    expect(p.v).toBe("bottom");
    expect(p.top).toBe(VP.height - 24 - EDGE_GAP);
    expect(p.left).toBe(300);
  });

  it("corner-snaps a wide strip to bottom-right, oriented along the long axis", () => {
    const p = chooseEdge(box(620, 760, 360, 24), VP, undefined);
    expect(p.edge).toBe("bottom"); // width >= height → horizontal
    expect(p.h).toBe("right");
    expect(p.v).toBe("bottom");
    expect(p.left).toBe(VP.width - 360 - EDGE_GAP);
    expect(p.top).toBe(VP.height - 24 - EDGE_GAP);
  });

  it("corner-snaps a tall strip to a vertical edge", () => {
    const p = chooseEdge(box(940, 700, 24, 220), VP, undefined);
    expect(p.edge).toBe("right"); // height > width → vertical
  });

  it("free-drop in the center flips edge across the midline along the current axis", () => {
    // Past center toward the left, but no edge is near → naturally "left".
    const p = chooseEdge(box(468, 300, 24, 220), VP, undefined);
    expect(p.edge).toBe("left");
  });

  it("hysteresis holds the current edge against a small cross-midline drag", () => {
    // Same geometry, but already docked right: the 120px bias keeps it on the right.
    const p = chooseEdge(box(468, 300, 24, 220), VP, "right");
    expect(p.edge).toBe("right");
  });
});

describe("pushOutOf", () => {
  it("springs a bottom-docked strip sideways, never off its edge", () => {
    const rect = box(320, 764, 360, 24); // centered horizontally, on the bottom edge
    const rail = box(440, 760, 120, 40); // the centered camera rail
    const { left, top } = pushOutOf(rect, [rail], "bottom", VP);
    expect(top).toBe(764); // stayed on the edge
    expect(left).toBeGreaterThan(320); // slid clear
    // no longer overlaps the rail
    expect(left).toBeGreaterThanOrEqual(560);
  });

  it("springs a left-docked strip vertically", () => {
    const rect = box(12, 300, 24, 220);
    const obstacle = box(0, 360, 60, 60); // chrome on the left edge
    const { left, top } = pushOutOf(rect, [obstacle], "left", VP);
    expect(left).toBe(12); // stayed docked
    expect(top).not.toBe(300); // moved vertically to clear
  });

  it("leaves a non-overlapping element untouched", () => {
    const rect = box(800, 764, 180, 24);
    const rail = box(440, 760, 120, 40);
    expect(pushOutOf(rect, [rail], "bottom", VP)).toEqual({ left: 800, top: 764 });
  });
});
