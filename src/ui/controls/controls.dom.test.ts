import { afterEach, describe, expect, it } from "vitest";
import { createPane } from "./pane.ts";

// happy-dom env: exercises the control facade's contract — change → onChange, set()
// reflects without re-firing onChange, setDisabled, and dispose() removes the row and its
// listeners. Structure/behavior only; styling (the :checked SVG rule) is not asserted.

function mount() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return parent;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("checkbox control", () => {
  it("emits on change, reflects via set without echoing, and cleans up on dispose", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "f" });
    const changes: boolean[] = [];
    const handle = folder.addCheckbox({
      label: "On",
      value: false,
      onChange: (v) => changes.push(v),
    });

    const input = handle.element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (input === null) throw new Error("no checkbox input");

    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(changes).toEqual([true]);

    handle.set(false); // reflect external value — must not fire onChange
    expect(input.checked).toBe(false);
    expect(changes).toEqual([true]);

    handle.setDisabled(true);
    expect(input.disabled).toBe(true);

    handle.dispose();
    input.dispatchEvent(new Event("change")); // listener gone → no further change
    expect(changes).toEqual([true]);
    pane.dispose();
  });
});

describe("select control", () => {
  it("lists options, emits the chosen value, and reflects via set", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "f" });
    const changes: string[] = [];
    const handle = folder.addSelect({
      label: "Field",
      value: "a",
      options: [
        { label: "Alpha", value: "a" },
        { label: "Beta", value: "b" },
      ],
      onChange: (v) => changes.push(v),
    });

    const select = handle.element.querySelector("select");
    if (select === null) throw new Error("no select");
    expect(select.options.length).toBe(2);

    select.value = "b";
    select.dispatchEvent(new Event("change"));
    expect(changes).toEqual(["b"]);

    handle.set("a");
    expect(select.value).toBe("a");
    expect(changes).toEqual(["b"]);
    pane.dispose();
  });

  it("rebuilds options via setOptions, keeping a surviving value", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "f" });
    const handle = folder.addSelect<string>({
      label: "Field",
      value: "b",
      options: [
        { label: "Alpha", value: "a" },
        { label: "Beta", value: "b" },
      ],
      onChange: () => {},
    });
    const select = handle.element.querySelector("select");
    if (select === null) throw new Error("no select");

    handle.setOptions([
      { label: "Beta", value: "b" },
      { label: "Gamma", value: "c" },
    ]);
    expect([...select.options].map((o) => o.value)).toEqual(["b", "c"]);
    expect(select.value).toBe("b"); // survived the rebuild

    handle.setOptions([{ label: "Gamma", value: "c" }]);
    expect(select.value).toBe("c"); // old value gone → browser falls back to first option
    pane.dispose();
  });
});

describe("slider control", () => {
  it("emits a number on input and reflects via set", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "f" });
    const changes: number[] = [];
    const handle = folder.addSlider({
      label: "Opacity",
      value: 0.5,
      min: 0,
      max: 1,
      step: 0.1,
      format: (v) => v.toFixed(1),
      onChange: (v) => changes.push(v),
    });

    const input = handle.element.querySelector<HTMLInputElement>('input[type="range"]');
    if (input === null) throw new Error("no range input");
    const readout = handle.element.querySelector(".webpic-slider_readout");

    input.value = "0.8";
    input.dispatchEvent(new Event("input"));
    expect(changes).toEqual([0.8]);
    expect(readout?.textContent).toBe("0.8");

    handle.set(0.2);
    expect(input.value).toBe("0.2");
    expect(readout?.textContent).toBe("0.2");
    expect(changes).toEqual([0.8]);
    pane.dispose();
  });
});

describe("text control", () => {
  it("emits on change and skips set while focused", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "f" });
    const changes: string[] = [];
    const handle = folder.addText({ label: "Name", value: "x", onChange: (v) => changes.push(v) });

    const input = handle.element.querySelector<HTMLInputElement>('input[type="text"]');
    if (input === null) throw new Error("no text input");

    input.value = "hello";
    input.dispatchEvent(new Event("change"));
    expect(changes).toEqual(["hello"]);

    input.focus();
    handle.set("ignored"); // focused → must not clobber the user's text
    expect(input.value).toBe("hello");
    input.blur();
    handle.set("synced");
    expect(input.value).toBe("synced");
    pane.dispose();
  });
});

describe("pane/folder lifecycle", () => {
  it("disposing the pane removes all DOM", () => {
    const parent = mount();
    const pane = createPane({ parent, title: "Panel" });
    const folder = pane.addFolder({ title: "Group" });
    folder.addCheckbox({ label: "a", value: true, onChange: () => {} });
    folder.addText({ label: "b", value: "", onChange: () => {} });
    expect(parent.querySelectorAll(".webpic-row").length).toBe(2);

    pane.dispose();
    expect(parent.querySelector(".webpic-pane")).toBeNull();
  });

  it("collapses a folder body via its header bar", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "Group" });
    const bar = folder.element.querySelector<HTMLButtonElement>(".webpic-folder_bar");
    const body = folder.element.querySelector<HTMLElement>(".webpic-folder_body");
    if (bar === null || body === null) throw new Error("missing folder parts");
    expect(body.hidden).toBe(false);
    bar.dispatchEvent(new Event("click"));
    expect(body.hidden).toBe(true);
    pane.dispose();
  });
});
