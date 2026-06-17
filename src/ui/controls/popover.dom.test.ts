import { afterEach, describe, expect, it, vi } from "vitest";
import { createPopover, type PopoverHandle } from "./popover.ts";

const handles: PopoverHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  document.body.replaceChildren();
});

interface Item {
  readonly value: string;
  readonly label: string;
}

function setup(initialSelected = "a") {
  const anchor = document.createElement("button");
  anchor.type = "button";
  document.body.appendChild(anchor);
  let items: Item[] = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
    { value: "c", label: "Gamma" },
  ];
  let selected = initialSelected;
  const onSelect = vi.fn((v: string) => {
    selected = v;
  });
  const handle = createPopover<Item>({
    anchor,
    getItems: () => items,
    getSelected: () => selected,
    onSelect,
    renderRow: (doc, item) => {
      const span = doc.createElement("span");
      span.textContent = item.label;
      return span;
    },
  });
  handles.push(handle);
  const panel = (): HTMLElement | null =>
    [...document.body.querySelectorAll<HTMLElement>(".webpic-popover")].find((p) => !p.hidden) ??
    null;
  const options = (): HTMLElement[] => [
    ...(panel()?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
  ];
  const activeValue = (): string | undefined =>
    panel()?.querySelector<HTMLElement>(".webpic-popover_item.is-active")?.dataset.value;
  return {
    anchor,
    handle,
    onSelect,
    panel,
    options,
    activeValue,
    setItems: (next: Item[]) => {
      items = next;
    },
  };
}

const key = (k: string): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
};

describe("createPopover", () => {
  it("opens on the anchor click, renders options, and marks the selected one", () => {
    const { anchor, options, panel } = setup("b");
    expect(panel()).toBeNull();
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(options()).toHaveLength(3);
    const selected = panel()?.querySelector<HTMLElement>('[aria-selected="true"]');
    expect(selected?.dataset.value).toBe("b");
  });

  it("toggles closed on a second anchor click", () => {
    const { anchor, panel } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(panel()).not.toBeNull();
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(panel()).toBeNull();
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });

  it("commits the clicked option and closes", () => {
    const { anchor, options, onSelect, panel } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    const beta = options().find((o) => o.dataset.value === "b");
    beta?.dispatchEvent(new MouseEvent("click"));
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(panel()).toBeNull();
  });

  it("closes on an outside pointerdown but stays open when clicking inside", () => {
    const { anchor, panel } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    panel()?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(panel()).not.toBeNull(); // inside → stays open
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(panel()).toBeNull(); // outside → closed
  });

  it("Escape closes and returns focus to the anchor", () => {
    const { anchor, panel } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    key("Escape");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it("arrow keys, Home, and End move the active option", () => {
    const { anchor, activeValue } = setup("a");
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(activeValue()).toBe("a"); // seeded at the selection
    key("ArrowDown");
    expect(activeValue()).toBe("b");
    key("End");
    expect(activeValue()).toBe("c");
    key("ArrowUp");
    expect(activeValue()).toBe("b");
    key("Home");
    expect(activeValue()).toBe("a");
  });

  it("Enter commits the active option", () => {
    const { anchor, onSelect } = setup("a");
    anchor.dispatchEvent(new MouseEvent("click"));
    key("ArrowDown"); // → "b"
    key("Enter");
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("refresh() rebuilds the rows from fresh data while open", () => {
    const { anchor, options, setItems, handle } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(options()).toHaveLength(3);
    setItems([{ value: "x", label: "Xi" }]);
    handle.refresh();
    expect(options()).toHaveLength(1);
    expect(options()[0]?.dataset.value).toBe("x");
  });

  it("dispose() removes the node and detaches the anchor listeners", () => {
    const { anchor, handle, panel } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    handle.dispose();
    expect(document.body.querySelector(".webpic-popover")).toBeNull();
    // The anchor click listener is gone — a later click must not resurrect a popover.
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(panel()).toBeNull();
  });
});
