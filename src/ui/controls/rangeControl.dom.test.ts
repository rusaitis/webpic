import { afterEach, describe, expect, it } from "vitest";
import { createPane } from "./pane.ts";
import type { RangeValue } from "./types.ts";

// happy-dom env: exercises the RangeControl facade contract via the layout-independent paths
// (text entry + keyboard), since happy-dom has no real geometry for pointer drags. Asserts
// callbacks-out / set()-in: edits emit onChange, set() reflects without echo, dispose cleans up.

function mount(): HTMLElement {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return parent;
}

afterEach(() => {
  document.body.replaceChildren();
});

function inputsOf(el: HTMLElement): HTMLInputElement[] {
  return Array.from(el.querySelectorAll<HTMLInputElement>(".webpic-range_input"));
}

describe("range control — interval mode", () => {
  it("emits [lo, hi] on text entry, reflects via set without echo, and cleans up", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "f" });
    const changes: RangeValue[] = [];
    const handle = folder.addRangeControl({
      label: "Window",
      min: 0,
      max: 10,
      range: [0, 10],
      onChange: (v) => changes.push(v),
    });

    const [inputA, inputB] = inputsOf(handle.element);
    if (!inputA || !inputB) throw new Error("interval mode needs two text inputs");

    inputA.value = "2";
    inputA.dispatchEvent(new Event("change"));
    expect(changes.at(-1)).toEqual([2, 10]);

    inputB.value = "8";
    inputB.dispatchEvent(new Event("change"));
    expect(changes.at(-1)).toEqual([2, 8]);

    const committed = changes.length;
    handle.set([1, 9]); // external reflection — must not fire onChange
    expect(inputA.value).toBe("1");
    expect(inputB.value).toBe("9");
    expect(changes.length).toBe(committed);

    handle.setDisabled(true);
    expect(inputA.disabled).toBe(true);
    expect(inputB.disabled).toBe(true);

    handle.dispose();
    inputA.value = "3";
    inputA.dispatchEvent(new Event("change")); // listeners gone → no further change
    expect(changes.length).toBe(committed);
    pane.dispose();
  });
});

describe("range control — single mode", () => {
  it("nudges on keyboard (onInput + onChange) and reflects via set", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "f" });
    const inputs: RangeValue[] = [];
    const changes: RangeValue[] = [];
    const handle = folder.addRangeControl({
      label: "Level",
      min: 0,
      max: 10,
      value: 5,
      step: 1,
      onInput: (v) => inputs.push(v),
      onChange: (v) => changes.push(v),
    });

    const grip = handle.element.querySelector<HTMLElement>('.webpic-range_grip[data-end="value"]');
    if (grip === null) throw new Error("single mode needs a value grip");

    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(changes.at(-1)).toBe(6);
    expect(inputs.at(-1)).toBe(6);

    const committed = changes.length;
    handle.set(3); // external reflection — no callback
    const [input] = inputsOf(handle.element);
    expect(input?.value).toBe("3");
    expect(changes.length).toBe(committed);
    pane.dispose();
  });
});
