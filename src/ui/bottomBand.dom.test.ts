import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { type BottomBand, createBottomBand } from "./bottomBand.ts";
import type { Box } from "./floating/dragSnap.ts";

// happy-dom lays nothing out, so the rail buttons and the strip stub their rects and the viewport
// width is pinned on documentElement. The band's decisions are asserted through what it writes:
// the rail's --webpic-rail-shift, the strip's inline left, the gnomon-suppression flag, and the
// host's collapse callback.

const bands: BottomBand[] = [];
afterEach(() => {
  for (const band of bands.splice(0)) band.dispose();
  // Restore the prototype getter the viewport-width stub shadowed.
  delete (document.documentElement as { clientWidth?: number }).clientWidth;
  document.body.replaceChildren();
});

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, width, top: 760, bottom: 784, height: 24 } as DOMRect;
}

function setViewportWidth(px: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: px,
    configurable: true,
  });
}

// A centered rail cluster of two buttons spanning [left, left + width].
function mountRail(left: number, width: number): HTMLElement {
  const rail = document.createElement("div");
  rail.className = "webpic-rail";
  const a = document.createElement("button");
  a.className = "webpic-rail_btn";
  a.getBoundingClientRect = () => rect(left, width / 2);
  const b = document.createElement("button");
  b.className = "webpic-rail_btn";
  b.getBoundingClientRect = () => rect(left + width / 2, width / 2);
  rail.append(a, b);
  document.body.appendChild(rail);
  return rail;
}

function setup(stripWidths = { expanded: 372, collapsed: 132 }) {
  const strip = document.createElement("div");
  strip.dataset.edge = "bottom";
  strip.style.left = "600px";
  document.body.appendChild(strip);
  const isCollapsed = (): boolean => strip.classList.contains("collapsed");
  strip.getBoundingClientRect = () =>
    rect(600, isCollapsed() ? stripWidths.collapsed : stripWidths.expanded);
  const uiStore = createUiStore();
  const reflows = { count: 0 };
  const band = createBottomBand({
    store: createSimulationStore(),
    uiStore,
    strip,
    isCollapsed,
    setCollapsed: (next) => strip.classList.toggle("collapsed", next),
    migrateToSide: (side) => {
      strip.dataset.edge = side;
    },
    reflow: () => reflows.count++,
  });
  bands.push(band);
  return { band, strip, uiStore, isCollapsed, reflows };
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("createBottomBand", () => {
  it("co-centers the rail with a strip docked beside it and releases it when hidden", () => {
    const rail = mountRail(400, 200); // natural cluster: [400, 600] on a 1000px viewport
    const { band, strip } = setup();
    const settled: Box = { left: 620, top: 760, right: 940, bottom: 784, width: 320, height: 24 };
    band.onSettled("bottom", settled, { width: 1000, height: 800 });
    // [cluster | 12 | strip] centered: the rail slides left by half of (gap + strip).
    expect(rail.style.getPropertyValue("--webpic-rail-shift")).toBe("-166px");
    // The strip is center-anchored: left = grouped slot's left + half its width (446 + 160).
    expect(strip.style.left).toBe("606px");
    expect(strip.style.right).toBe("auto");

    band.onSettled("left", settled, { width: 1000, height: 800 }); // another edge → rail alone
    expect(rail.style.getPropertyValue("--webpic-rail-shift")).toBe("0px");

    band.onSettled("bottom", settled, { width: 1000, height: 800 });
    band.setVisible(false);
    expect(rail.style.getPropertyValue("--webpic-rail-shift")).toBe("0px");
  });

  it("sheds the gnomon when the rail can't clear its corner reserve, and restores it", async () => {
    mountRail(40, 240);
    setViewportWidth(320); // 320 < 240 + 2×80 → cramped
    const { band, uiStore } = setup();
    band.setVisible(true);
    await frame();
    expect(uiStore.getState().isGnomonSuppressed).toBe(true);
    band.setVisible(false);
    expect(uiStore.getState().isGnomonSuppressed).toBe(false);
  });

  it("auto-collapses the strip when the expanded group no longer fits, and expands it back", async () => {
    mountRail(190, 240);
    setViewportWidth(620); // budget 604: 240+12+372 overflows, 240+12+132 fits
    const { band, isCollapsed } = setup();
    band.setVisible(true);
    await frame();
    expect(isCollapsed()).toBe(true);

    setViewportWidth(1400);
    window.dispatchEvent(new Event("resize"));
    await frame();
    expect(isCollapsed()).toBe(false); // a fit-driven collapse is undone once there's room
  });

  it("never undoes a manual collapse", async () => {
    mountRail(580, 240);
    setViewportWidth(1400);
    const { band, isCollapsed, reflows } = setup();
    band.setVisible(true);
    await frame();
    band.collapse(true);
    expect(isCollapsed()).toBe(true);
    expect(reflows.count).toBeGreaterThan(0); // the strip resized in place → re-clamped now
    window.dispatchEvent(new Event("resize"));
    await frame();
    expect(isCollapsed()).toBe(true);
  });

  it("releases the rail and the gnomon on dispose", async () => {
    const rail = mountRail(40, 240);
    setViewportWidth(320);
    const { band, uiStore } = setup();
    band.setVisible(true);
    await frame();
    rail.style.setProperty("--webpic-rail-shift", "-40px");
    band.dispose();
    expect(rail.style.getPropertyValue("--webpic-rail-shift")).toBe("0px");
    expect(uiStore.getState().isGnomonSuppressed).toBe(false);
  });
});
