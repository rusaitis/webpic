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
  it("renders the RangeControl primitive and emits a number once per change", () => {
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

    // Same chrome as the Window/Step sliders — grip + coupled text field, no native input.
    const grip = handle.element.querySelector<HTMLElement>(".webpic-range_grip");
    const text = handle.element.querySelector<HTMLInputElement>(".webpic-range_input");
    if (grip === null || text === null) throw new Error("no range-control chrome");
    expect(handle.element.querySelector('input[type="range"]')).toBeNull();

    // Keyboard fires both the live and commit paths; the facade dedupes to one emit.
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toBeCloseTo(0.6, 12); // 0.5 + 0.1 in floats; format cleans the display
    expect(text.value).toBe("0.6");

    // Text entry is the precise path.
    text.value = "0.8";
    text.dispatchEvent(new Event("change"));
    expect(changes).toHaveLength(2);
    expect(changes[1]).toBe(0.8);

    handle.set(0.2);
    expect(text.value).toBe("0.2");
    expect(changes).toHaveLength(2); // reflection must not echo
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

  it("renders a note inside the folder body and removes it on dispose", () => {
    const pane = createPane({ parent: mount() });
    const folder = pane.addFolder({ title: "Group" });
    const body = folder.element.querySelector<HTMLElement>(".webpic-folder_body");
    if (body === null) throw new Error("no folder body");
    const note = folder.addNote("Coming soon");
    // Lives in the body (not the folder root), so it collapses with the folder.
    expect(note.element.parentElement).toBe(body);
    expect(note.element.textContent).toBe("Coming soon");
    note.dispose();
    expect(body.querySelector(".webpic-placeholder")).toBeNull();
    pane.dispose();
  });
});
