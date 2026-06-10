import { createSimulationStore, createUiStore, DEFAULT_POSE } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { gnomonTransform, installCameraChrome } from "./cameraChrome.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function setup() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const store = createSimulationStore();
  const uiStore = createUiStore();
  const dispose = installCameraChrome(parent, store, uiStore);
  disposers.push(dispose);
  const chrome = parent.querySelector<HTMLElement>(".webpic-chrome");
  if (chrome === null) throw new Error("chrome not mounted");
  return { parent, store, uiStore, chrome, dispose };
}

describe("installCameraChrome", () => {
  it("renders the default pose into the readout and gnomon", () => {
    const { chrome } = setup();
    const readout = chrome.querySelector(".webpic-readout");
    const scene = chrome.querySelector<HTMLElement>(".webpic-gnomon_scene");
    expect(readout?.textContent).toContain(`d ${DEFAULT_POSE.distance.toFixed(2)}`);
    expect(scene?.style.transform).toMatch(/^matrix3d\(/);
    // Three color-coded axis arms (X/Y/Z).
    expect(chrome.querySelectorAll(".webpic-gnomon_axis")).toHaveLength(3);
  });

  it("reflects pose changes live", () => {
    const { store, chrome } = setup();
    const scene = chrome.querySelector<HTMLElement>(".webpic-gnomon_scene");
    const before = scene?.style.transform;

    store.getState().setCameraPose({ target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 9.99 });
    expect(chrome.querySelector(".webpic-readout")?.textContent).toContain("d 9.99");
    expect(scene?.style.transform).not.toBe(before);
  });

  it("hides with the global UI toggle", () => {
    const { uiStore, chrome } = setup();
    expect(chrome.hidden).toBe(false);
    uiStore.getState().toggleUi(); // visible → hidden
    expect(chrome.hidden).toBe(true);
    uiStore.getState().toggleUi();
    expect(chrome.hidden).toBe(false);
  });

  it("removes the container on dispose", () => {
    const { parent, dispose } = setup();
    dispose();
    expect(parent.querySelector(".webpic-chrome")).toBeNull();
  });
});

// The gnomon must show the world axes exactly as the z-up camera projects them. Arms in scene space:
// is-x=+x̂→col1, is-y=−ẑ→−col3, is-z=−ŷ→−col2 (CSS y is down, so screen-up = −y). A pure rotation.
describe("gnomonTransform", () => {
  const cols = (pose: Parameters<typeof gnomonTransform>[0]): number[] =>
    (gnomonTransform(pose).match(/matrix3d\(([^)]*)\)/)?.[1] ?? "").split(",").map(Number);

  it("from a level +x view, maps world x→toward-viewer, y→screen-right, z→screen-up", () => {
    const m = cols({ target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 1 });
    const worldX = [m[0], m[1], m[2]]; // col1
    const worldY = [-(m[8] ?? 0), -(m[9] ?? 0), -(m[10] ?? 0)]; // −col3
    const worldZ = [-(m[4] ?? 0), -(m[5] ?? 0), -(m[6] ?? 0)]; // −col2
    // CSS (x right, y down, z toward viewer): looking down −x, world +x is toward the viewer,
    // world +y is to the right, world +z is up (−y_css).
    expect(worldX[0]).toBeCloseTo(0, 5);
    expect(worldX[2]).toBeCloseTo(1, 5); // toward viewer
    expect(worldY[0]).toBeCloseTo(1, 5); // right
    expect(worldZ[1]).toBeCloseTo(-1, 5); // up (CSS y is down)
  });

  it("is a proper rotation (orthonormal columns, no mirror)", () => {
    const m = cols({ target: [0, 0, 0], azimuth: 0.7, elevation: 0.4, distance: 2 });
    const c1 = [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0];
    const c2 = [m[4] ?? 0, m[5] ?? 0, m[6] ?? 0];
    const len = (v: number[]) => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    const dot = (a: number[], b: number[]) =>
      (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
    // Precision 4: the matrix3d string rounds each entry to 5 decimals, so dot/len carry ~1e-5 noise.
    expect(len(c1)).toBeCloseTo(1, 4);
    expect(len(c2)).toBeCloseTo(1, 4);
    expect(dot(c1, c2)).toBeCloseTo(0, 4);
  });
});
