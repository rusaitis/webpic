import { createSimulationStore, createUiStore, DEFAULT_POSE } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installCameraChrome } from "./cameraChrome.ts";

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
    expect(scene?.style.transform).toMatch(/rotateX\(.*deg\) rotateY\(.*deg\)/);
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
