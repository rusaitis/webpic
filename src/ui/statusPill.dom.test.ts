import { createUiStore } from "@store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installStatusPill,
  STATUS_ERROR_VISIBLE_MS,
  STATUS_MIN_VISIBLE_MS,
  STATUS_SHOW_DELAY_MS,
} from "./statusPill.ts";

const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const uiStore = createUiStore();
  const dispose = installStatusPill(parent, uiStore);
  disposers.push(dispose);
  const pill = parent.querySelector<HTMLElement>(".webpic-status");
  if (pill === null) throw new Error("pill not mounted");
  return { parent, uiStore, pill, dispose };
}

const isVisible = (pill: HTMLElement): boolean => pill.classList.contains("is-visible");

describe("installStatusPill", () => {
  it("shows only after the delay, with the latest phase message", () => {
    const { uiStore, pill } = setup();
    expect(isVisible(pill)).toBe(false);

    uiStore.getState().beginLoading("step", "loading step 2");
    expect(isVisible(pill)).toBe(false); // delayed — fast ops never paint
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS - 1);
    expect(isVisible(pill)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isVisible(pill)).toBe(true);
    expect(pill.querySelector(".webpic-status_text")?.textContent).toBe("loading step 2");
  });

  it("never shows for an op that completes inside the delay", () => {
    const { uiStore, pill } = setup();
    uiStore.getState().beginLoading("step", "loading step 3");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS - 50);
    uiStore.getState().endLoading("step");
    vi.advanceTimersByTime(1000);
    expect(isVisible(pill)).toBe(false);
  });

  it("holds the pill up for the min-visible window before hiding", () => {
    const { uiStore, pill } = setup();
    uiStore.getState().beginLoading("open", "opening dataset");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS);
    expect(isVisible(pill)).toBe(true);

    uiStore.getState().endLoading("open"); // immediately after show
    vi.advanceTimersByTime(STATUS_MIN_VISIBLE_MS - 1);
    expect(isVisible(pill)).toBe(true); // no blink
    vi.advanceTimersByTime(1);
    expect(isVisible(pill)).toBe(false);
  });

  it("cancels a pending hide when a new phase begins", () => {
    const { uiStore, pill } = setup();
    uiStore.getState().beginLoading("step", "loading step 1");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS);
    uiStore.getState().endLoading("step");
    uiStore.getState().beginLoading("step", "loading step 2"); // before min-visible expires
    vi.advanceTimersByTime(STATUS_MIN_VISIBLE_MS + 100);
    expect(isVisible(pill)).toBe(true);
    expect(pill.querySelector(".webpic-status_text")?.textContent).toBe("loading step 2");
  });

  it("stays visible through nested phases; the oldest owns the text until it ends", () => {
    const { uiStore, pill } = setup();
    uiStore.getState().beginLoading("boot", "webpic");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS);
    uiStore.getState().beginLoading("step", "loading step 5");
    // Oldest-active wins — the text never reverts when a newer phase ends first.
    expect(pill.querySelector(".webpic-status_text")?.textContent).toBe("webpic");

    uiStore.getState().endLoading("boot");
    expect(isVisible(pill)).toBe(true); // step still active — no flicker
    expect(pill.querySelector(".webpic-status_text")?.textContent).toBe("loading step 5");
    uiStore.getState().endLoading("step");
    vi.advanceTimersByTime(STATUS_MIN_VISIBLE_MS);
    expect(isVisible(pill)).toBe(false);
  });

  it("shows errors immediately and auto-clears them", () => {
    const { uiStore, pill } = setup();
    uiStore.getState().flashError("stream failed");
    expect(isVisible(pill)).toBe(true); // errors skip the show delay
    expect(pill.dataset.kind).toBe("error");
    expect(pill.querySelector(".webpic-status_text")?.textContent).toBe("stream failed");

    vi.advanceTimersByTime(STATUS_ERROR_VISIBLE_MS);
    expect(uiStore.getState().statusError).toBeNull();
    expect(pill.dataset.kind).toBeUndefined();
    vi.advanceTimersByTime(STATUS_MIN_VISIBLE_MS);
    expect(isVisible(pill)).toBe(false);
  });

  it("resumes the loading display after an error clears with phases still active", () => {
    const { uiStore, pill } = setup();
    uiStore.getState().beginLoading("step", "loading step 9");
    uiStore.getState().flashError("read failed");
    vi.advanceTimersByTime(STATUS_ERROR_VISIBLE_MS);
    expect(isVisible(pill)).toBe(true); // phase still active — pill stays, back in loading style
    expect(pill.dataset.kind).toBeUndefined();
    expect(pill.querySelector(".webpic-status_text")?.textContent).toBe("loading step 9");
  });

  it("adopts the boot splash: removes it and starts visible when work is in flight", () => {
    const splash = document.createElement("p");
    splash.id = "splash";
    splash.textContent = "webpic";
    document.body.appendChild(splash);

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const uiStore = createUiStore();
    uiStore.getState().beginLoading("boot", "webpic");
    const dispose = installStatusPill(parent, uiStore);
    disposers.push(dispose);

    expect(document.getElementById("splash")).toBeNull();
    const pill = parent.querySelector<HTMLElement>(".webpic-status");
    expect(pill !== null && isVisible(pill)).toBe(true); // no entrance delay — seamless swap
    expect(pill?.querySelector(".webpic-status_text")?.textContent).toBe("webpic");
  });

  it("removes the element and leaves no live timers on dispose", () => {
    const { parent, uiStore, dispose } = setup();
    uiStore.getState().beginLoading("step", "loading step 1");
    dispose();
    expect(parent.querySelector(".webpic-status")).toBeNull();
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
  });
});
