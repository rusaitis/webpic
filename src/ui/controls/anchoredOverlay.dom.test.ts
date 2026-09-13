import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnchoredOverlayOptions, installAnchoredOverlay } from "./anchoredOverlay.ts";

// Every install listens on the document, so one left behind answers the next test's Escape first.
const installed: AbortController[] = [];
afterEach(() => {
  for (const controller of installed.splice(0)) controller.abort();
});

function mount(overrides: Partial<AnchoredOverlayOptions> = {}) {
  document.body.replaceChildren();
  const overlay = document.createElement("div");
  const trigger = document.createElement("button");
  const outside = document.createElement("div");
  document.body.append(overlay, trigger, outside);

  let isOpen = true;
  const close = vi.fn(() => {
    isOpen = false;
  });
  const abortController = new AbortController();
  installed.push(abortController);
  installAnchoredOverlay({
    overlay,
    trigger,
    isOpen: () => isOpen,
    close,
    signal: abortController.signal,
    ...overrides,
  });
  const dispose = (): void => {
    abortController.abort();
  };
  return { overlay, trigger, outside, close, dispose, setOpen: (next: boolean) => (isOpen = next) };
}

const pressEscape = (): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
};
const press = (element: HTMLElement): void => {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
};

describe("installAnchoredOverlay", () => {
  it("closes on Escape and returns focus to the trigger", () => {
    const { trigger, close } = mount();

    pressEscape();

    expect(close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves Escape alone while closed, so it reaches whatever else is open", () => {
    const { close, setOpen } = mount();
    setOpen(false);

    pressEscape();

    expect(close).not.toHaveBeenCalled();
  });

  it("closes without stealing focus when the caller opts out", () => {
    const { trigger, close } = mount({ shouldRestoreFocus: false });

    pressEscape();

    expect(close).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(trigger);
  });

  it("closes on a press outside but not on one inside the overlay or its trigger", () => {
    const { overlay, trigger, outside, close } = mount();

    press(overlay);
    press(trigger);
    expect(close).not.toHaveBeenCalled();

    press(outside);
    expect(close).toHaveBeenCalledOnce();
  });

  it("repositions on resize only while open", () => {
    const position = vi.fn();
    const { setOpen } = mount({ position });

    window.dispatchEvent(new Event("resize"));
    expect(position).toHaveBeenCalledOnce();

    setOpen(false);
    window.dispatchEvent(new Event("resize"));
    expect(position).toHaveBeenCalledOnce();
  });

  it("stops responding once disposed, and disposing twice is harmless", () => {
    const { outside, close, dispose } = mount();

    dispose();
    dispose();
    pressEscape();
    press(outside);

    expect(close).not.toHaveBeenCalled();
  });
});
