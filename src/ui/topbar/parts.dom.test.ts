import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindReveal,
  makePickerButton,
  makeStepButton,
  makeTopBarCaret,
  makeTopBarIconButton,
} from "./parts.ts";

describe("bindReveal", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("marks a picker button as owning a listbox, collapsed", () => {
    const button = makePickerButton(document, "dataset", "webpic-topbar_dataset", "Dataset");
    expect(button.type).toBe("button");
    expect(button.dataset.control).toBe("dataset");
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("styles a step button apart from the filled icon buttons", () => {
    const step = makeStepButton(document, "step-next", "M0 0", "Next step");
    const icon = makeTopBarIconButton(document, "more", "M0 0", "More");
    expect(step.className).toContain("webpic-topbar_step-btn");
    expect(icon.className).toContain("webpic-topbar_icon");
    expect(makeTopBarCaret(document).className).toContain("webpic-topbar_caret");
  });
});

describe("bindReveal", () => {
  let wrapper: HTMLElement;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    trigger = document.createElement("button");
    wrapper.appendChild(trigger);
    document.body.appendChild(wrapper);
  });

  it("toggles on each trigger click, reflecting state into aria-expanded", () => {
    const reveal = bindReveal(wrapper, trigger, new AbortController().signal);
    trigger.click();
    expect(reveal.isExpanded()).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.click();
    expect(reveal.isExpanded()).toBe(false);
  });

  it("announces only an opening, so a close never re-closes its siblings", () => {
    const onOpen = vi.fn();
    bindReveal(wrapper, trigger, new AbortController().signal, onOpen);
    trigger.click();
    trigger.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const reveal = bindReveal(wrapper, trigger, new AbortController().signal);
    reveal.setExpanded(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reveal.isExpanded()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves Escape alone while collapsed, so it reaches whatever else is open", () => {
    const reveal = bindReveal(wrapper, trigger, new AbortController().signal);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reveal.isExpanded()).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it("stops responding once the signal aborts", () => {
    const abortController = new AbortController();
    const reveal = bindReveal(wrapper, trigger, abortController.signal);
    abortController.abort();
    trigger.click();
    expect(reveal.isExpanded()).toBe(false);
  });
});
