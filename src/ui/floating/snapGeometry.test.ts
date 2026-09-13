import { describe, expect, it } from "vitest";
import { type Box, chooseEdge, freePlacement, pushOutOf, type Viewport } from "./snapGeometry.ts";

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
    expect(p.isDocked).toBe(true);
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
    expect(p.h).toBe("left"); // left-leaning (center past midline toward the left)
    expect(p.v).toBe("bottom");
    expect(p.top).toBe(VP.height - 24 - EDGE_GAP);
    expect(p.left).toBe(300);
  });

  it("anchors a right-leaning bottom drop to the right edge so it tracks on resize", () => {
    const p = chooseEdge(box(500, 770, 360, 24), VP, undefined);
    expect(p.edge).toBe("bottom");
    expect(p.h).toBe("right"); // glued to the right corner, not a stale fixed-left offset
    expect(p.left).toBe(500); // top-left x preserved; setAnchors converts to a right anchor
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
    // A middle drop is *not* isDocked: the edge is an orientation hint, the drop point is preserved so
    // a later collapse/expand resizes in place instead of migrating to the edge.
    expect(p.isDocked).toBe(false);
    expect(p.left).toBe(468);
    expect(p.top).toBe(300);
  });

  it("hysteresis holds the current edge against a small cross-midline drag", () => {
    // Same geometry, but already isDocked right: the 120px bias keeps it on the right.
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
    expect(left).toBe(12); // stayed isDocked
    expect(top).not.toBe(300); // moved vertically to clear
  });

  it("leaves a non-overlapping element untouched", () => {
    const rect = box(800, 764, 180, 24);
    const rail = box(440, 760, 120, 40);
    expect(pushOutOf(rect, [rail], "bottom", VP)).toEqual({ left: 800, top: 764 });
  });

  it("clears a wide obstacle flanked by narrow ones (greedy alone would stall)", () => {
    // The collapsed strip dropped over a wide chip between two icon buttons: the min-push greedy
    // oscillates past the narrow neighbours, so the union fallback must spring it fully clear.
    const fit = box(400, 760, 32, 32);
    const coords = box(440, 760, 120, 32); // the wide chip
    const help = box(568, 760, 32, 32);
    const rect = box(460, 760, 148, 32); // overlaps coords + help
    const { left, top } = pushOutOf(rect, [fit, coords, help], "bottom", VP);
    expect(top).toBe(760); // stayed on the dock row
    for (const o of [fit, coords, help]) {
      expect(left >= o.right || left + 148 <= o.left).toBe(true); // fully clear of each
    }
  });
});

describe("freePlacement", () => {
  it("leaves a rect already inside the viewport untouched", () => {
    expect(freePlacement(box(500, 400, 240, 180), VP)).toEqual({ left: 500, top: 400 });
  });

  it("allows left/right overhang, keeping a grab strip (64px) on screen", () => {
    expect(freePlacement(box(-120, 400, 240, 180), VP)).toEqual({ left: -120, top: 400 }); // tucked off the left
    expect(freePlacement(box(-500, 400, 240, 180), VP)).toEqual({ left: 64 - 240, top: 400 }); // capped: 64px stays
    expect(freePlacement(box(2000, 400, 240, 180), VP)).toEqual({ left: 1000 - 64, top: 400 }); // capped off the right
  });

  it("lets the panel hang off the bottom but never above the top (header stays grabbable)", () => {
    expect(freePlacement(box(500, -50, 240, 180), VP)).toEqual({ left: 500, top: 8 }); // top held at the margin
    expect(freePlacement(box(500, 2000, 240, 180), VP)).toEqual({ left: 500, top: 800 - 64 }); // 64px stays at top
  });
});
