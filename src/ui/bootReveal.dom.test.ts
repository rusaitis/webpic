import { createUiStore, PHASE_KEYS } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { BOOTING_CLASS, installBootReveal } from "./bootReveal.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function setup(boot = true) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const uiStore = createUiStore();
  if (boot) uiStore.getState().beginLoading(PHASE_KEYS.boot, "webpic");
  const dispose = installBootReveal(parent, uiStore);
  disposers.push(dispose);
  return { parent, uiStore, dispose };
}

const isHidden = (parent: HTMLElement): boolean => parent.classList.contains(BOOTING_CLASS);

describe("installBootReveal", () => {
  it("hides the chrome while boot is live and reveals when it ends", () => {
    const { parent, uiStore } = setup();
    expect(isHidden(parent)).toBe(true);
    uiStore.getState().endLoading(PHASE_KEYS.boot);
    expect(isHidden(parent)).toBe(false);
  });

  it("reveals on boot end even while other phases are still live", () => {
    const { parent, uiStore } = setup();
    uiStore.getState().beginLoading("open", "opening dataset");
    uiStore.getState().endLoading(PHASE_KEYS.boot);
    expect(isHidden(parent)).toBe(false);
  });

  it("is a no-op when boot already ended before install", () => {
    const { parent, uiStore } = setup(false);
    expect(isHidden(parent)).toBe(false);
    uiStore.getState().beginLoading("step", "loading step 1");
    expect(isHidden(parent)).toBe(false);
  });

  it("never re-hides: a re-begun boot phase leaves the revealed UI alone", () => {
    const { parent, uiStore } = setup();
    uiStore.getState().endLoading(PHASE_KEYS.boot);
    uiStore.getState().beginLoading(PHASE_KEYS.boot, "webpic");
    expect(isHidden(parent)).toBe(false);
  });

  it("dispose mid-boot removes the class and stops watching", () => {
    const { parent, uiStore, dispose } = setup();
    dispose();
    expect(isHidden(parent)).toBe(false);
    uiStore.getState().beginLoading(PHASE_KEYS.boot, "webpic");
    expect(isHidden(parent)).toBe(false);
  });
});
