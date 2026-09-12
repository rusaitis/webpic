import { describe, expect, it } from "vitest";
import type { Box } from "../floating/dragSnap.ts";
import {
  bottomDockLayout,
  colorbarFitMode,
  GROUP_GAP_PX,
  railGnomonCramped,
} from "./bottomDock.ts";

const G = GROUP_GAP_PX;

function box(left: number, width: number): Box {
  // The bottom dock only reads left/width; top/height are immaterial (all on the bottom row).
  return { left, top: 760, right: left + width, bottom: 784, width, height: 24 };
}

describe("bottomDockLayout", () => {
  it("centers [cluster | gap | colorbar] when the colorbar drops just right of the rail", () => {
    const vw = 1000;
    const cluster = 200;
    const r = bottomDockLayout({
      colorbar: box(620, 320), // center 780 > 500 → right side; 20px past the natural band
      clusterWidth: cluster,
      viewportWidth: vw,
      cornerClearRight: 0,
    });
    expect(r.isGrouped).toBe(true);
    expect(r.side).toBe("right");
    // Rail slides left by half the (gap + colorbar) it must make room for.
    expect(r.railShift).toBeCloseTo(-(G + 320) / 2, 6);
    // The resolved group is exactly centered on the viewport.
    const naturalClusterLeft = (vw - cluster) / 2;
    const clusterLeft = naturalClusterLeft + r.railShift;
    const groupCenter = (clusterLeft + (r.colorbarLeft ?? 0) + 320) / 2;
    expect(groupCenter).toBeCloseTo(vw / 2, 6);
    // Colorbar sits one gap to the right of the shifted cluster.
    expect(r.colorbarLeft).toBeCloseTo(clusterLeft + cluster + G, 6);
  });

  it("centers the mirror [colorbar | gap | cluster] when it drops left of the rail", () => {
    const vw = 1000;
    const cluster = 200;
    const r = bottomDockLayout({
      colorbar: box(200, 320), // center 360 < 500 → left side
      clusterWidth: cluster,
      viewportWidth: vw,
      cornerClearRight: 0,
    });
    expect(r.isGrouped).toBe(true);
    expect(r.side).toBe("left");
    expect(r.railShift).toBeCloseTo((G + 320) / 2, 6); // rail slides right
    const naturalClusterLeft = (vw - cluster) / 2;
    const clusterLeft = naturalClusterLeft + r.railShift;
    const groupCenter = ((r.colorbarLeft ?? 0) + clusterLeft + cluster) / 2;
    expect(groupCenter).toBeCloseTo(vw / 2, 6);
    expect(r.colorbarLeft).toBeCloseTo(clusterLeft - G - 320, 6);
  });

  it("floats (rail centered alone) when the colorbar drops far along the bottom", () => {
    const r = bottomDockLayout({
      colorbar: box(900, 90), // bottom-right corner, well clear of the centered rail
      clusterWidth: 200,
      viewportWidth: 1000,
      cornerClearRight: 0,
    });
    expect(r.isGrouped).toBe(false);
    expect(r.railShift).toBe(0);
    expect(r.colorbarLeft).toBeNull();
  });

  it("never groups when there is no rail cluster to dock against", () => {
    const r = bottomDockLayout({
      colorbar: box(480, 320), // dead center, but no cluster
      clusterWidth: 0,
      viewportWidth: 1000,
      cornerClearRight: 0,
    });
    expect(r.isGrouped).toBe(false);
    expect(r.railShift).toBe(0);
  });

  it("clamps the group right of the corner gnomon, gluing the colorbar to the shifted cluster", () => {
    const vw = 320; // cramped: the centered group would slide under the corner widget
    const cluster = 120;
    const r = bottomDockLayout({
      colorbar: box(190, 110), // right side
      clusterWidth: cluster,
      viewportWidth: vw,
      cornerClearRight: 68, // gnomon right edge
    });
    expect(r.isGrouped).toBe(true);
    const clusterLeft = (vw - cluster) / 2 + r.railShift;
    expect(clusterLeft).toBeGreaterThanOrEqual(68 + 12 - 1e-6); // cleared the gnomon + corner gap
    expect(r.colorbarLeft).toBeCloseTo(clusterLeft + cluster + G, 6); // still one gap apart
  });
});

describe("colorbarFitMode", () => {
  const widths = { expandedWidth: 372, collapsedWidth: 132 };

  it("stays expanded with ample room beside the rail", () => {
    expect(
      colorbarFitMode({ viewportWidth: 1400, clusterWidth: 220, cornerClearRight: 0, ...widths }),
    ).toBe("expanded");
  });

  it("collapses when the expanded strip no longer fits but the collapsed one does", () => {
    // budget = vw - 16; expanded total 240+12+372=624, collapsed 384. vw=620 → budget 604: only collapsed fits.
    expect(
      colorbarFitMode({ viewportWidth: 620, clusterWidth: 240, cornerClearRight: 0, ...widths }),
    ).toBe("collapsed");
  });

  it("migrates when even the collapsed strip can't sit beside the rail", () => {
    expect(
      colorbarFitMode({ viewportWidth: 360, clusterWidth: 240, cornerClearRight: 0, ...widths }),
    ).toBe("migrate");
  });

  it("is monotonic in width — once collapsed, widening never skips straight past expanded", () => {
    const at = (vw: number) =>
      colorbarFitMode({ viewportWidth: vw, clusterWidth: 220, cornerClearRight: 0, ...widths });
    const order = { migrate: 0, collapsed: 1, expanded: 2 } as const;
    for (let vw = 300; vw <= 1200; vw += 20) {
      expect(order[at(vw)]).toBeGreaterThanOrEqual(order[at(vw - 20)]);
    }
  });

  it("never groups (always expanded) when there is no rail", () => {
    expect(
      colorbarFitMode({ viewportWidth: 200, clusterWidth: 0, cornerClearRight: 0, ...widths }),
    ).toBe("expanded");
  });

  it("a visible gnomon eats into the budget, collapsing sooner", () => {
    const base = { viewportWidth: 700, clusterWidth: 240, ...widths };
    expect(colorbarFitMode({ ...base, cornerClearRight: 0 })).toBe("expanded");
    expect(colorbarFitMode({ ...base, cornerClearRight: 80 })).toBe("collapsed");
  });
});

describe("railGnomonCramped", () => {
  it("is roomy when the viewport clears the cluster plus both 80px gnomon reserves", () => {
    expect(railGnomonCramped(600, 240, false)).toBe(false); // 600 >= 240 + 160
    expect(railGnomonCramped(399, 240, false)).toBe(true); // 399 < 400
  });

  it("applies hysteresis so a just-restored gnomon doesn't flicker at the boundary", () => {
    // 410 is past the 400 cramp threshold, but within the +24 restore band while suppressed.
    expect(railGnomonCramped(410, 240, true)).toBe(true);
    expect(railGnomonCramped(410, 240, false)).toBe(false);
    expect(railGnomonCramped(430, 240, true)).toBe(false); // clear of the hysteresis band → restore
  });

  it("never cramps without a rail cluster", () => {
    expect(railGnomonCramped(100, 0, false)).toBe(false);
  });
});
