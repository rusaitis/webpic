import { afterEach, describe, expect, it } from "vitest";
import { installRailMenu, type RailMenuItem } from "./railMenu.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function setup(initial: RailMenuItem[] = [{ id: "a", label: "Alpha" }]) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const anchor = document.createElement("button");
  parent.appendChild(anchor);
  let items = initial;
  let selected: string | null = null;
  const picked: string[] = [];
  let addCalls = 0;
  const handle = installRailMenu({
    anchor,
    parent,
    title: "Volume layers",
    getItems: () => items,
    getSelected: () => selected,
    onPick: (id) => picked.push(id),
    onAddNew: () => {
      addCalls += 1;
    },
  });
  disposers.push(handle.dispose);
  const menu = (): HTMLElement => {
    const el = parent.querySelector<HTMLElement>(".webpic-railmenu");
    if (el === null) throw new Error("menu not mounted");
    return el;
  };
  return {
    parent,
    anchor,
    handle,
    menu,
    picked,
    addCalls: () => addCalls,
    setItems: (next: RailMenuItem[]) => {
      items = next;
    },
    setSelected: (id: string | null) => {
      selected = id;
    },
  };
}

describe("installRailMenu", () => {
  it("opens on anchor click and lists instances + Add new", () => {
    const { anchor, menu } = setup([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ]);
    expect(menu().hidden).toBe(true);
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(menu().hidden).toBe(false);
    expect(menu().querySelectorAll(".webpic-railmenu_item")).toHaveLength(2);
    expect(menu().querySelector(".webpic-railmenu_add")).not.toBeNull();
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles closed on a second click", () => {
    const { anchor, menu } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(menu().hidden).toBe(true);
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks the selected instance active", () => {
    const { anchor, menu, setSelected } = setup([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ]);
    setSelected("b");
    anchor.dispatchEvent(new MouseEvent("click"));
    const rows = [...menu().querySelectorAll(".webpic-railmenu_item")];
    expect(rows[0]?.classList.contains("is-active")).toBe(false);
    expect(rows[1]?.classList.contains("is-active")).toBe(true);
  });

  it("picks an instance (onPick) and closes", () => {
    const { anchor, menu, picked } = setup([{ id: "a", label: "Alpha" }]);
    anchor.dispatchEvent(new MouseEvent("click"));
    const row = menu().querySelector<HTMLButtonElement>(".webpic-railmenu_item");
    row?.dispatchEvent(new MouseEvent("click"));
    expect(picked).toEqual(["a"]);
    expect(menu().hidden).toBe(true);
  });

  it("adds (onAddNew) and closes", () => {
    const { anchor, menu, addCalls } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    menu()
      .querySelector<HTMLButtonElement>(".webpic-railmenu_add")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(addCalls()).toBe(1);
    expect(menu().hidden).toBe(true);
  });

  it("Escape closes the menu", () => {
    const { anchor, menu } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu().hidden).toBe(true);
  });

  it("an outside pointer-down closes the menu", () => {
    const { parent, anchor, menu } = setup();
    anchor.dispatchEvent(new MouseEvent("click"));
    parent.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu().hidden).toBe(true);
  });

  it("refresh rebuilds rows when the instance list changed while open", () => {
    const { anchor, menu, setItems, handle } = setup([{ id: "a", label: "Alpha" }]);
    anchor.dispatchEvent(new MouseEvent("click"));
    expect(menu().querySelectorAll(".webpic-railmenu_item")).toHaveLength(1);
    setItems([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ]);
    handle.refresh();
    expect(menu().querySelectorAll(".webpic-railmenu_item")).toHaveLength(2);
  });

  it("removes the menu on dispose", () => {
    const { parent, handle } = setup();
    handle.dispose();
    expect(parent.querySelector(".webpic-railmenu")).toBeNull();
  });
});
