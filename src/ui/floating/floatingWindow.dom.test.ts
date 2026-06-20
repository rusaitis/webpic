import { afterEach, describe, expect, it } from "vitest";
import { createFloatingWindow } from "./floatingWindow.ts";

function el<T extends HTMLElement>(root: ParentNode, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (found === null) throw new Error(`missing ${sel}`);
  return found;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("createFloatingWindow", () => {
  it("mounts the window chrome — grip, titled bar, body, resize handle", () => {
    const win = createFloatingWindow({ parent: document.body, title: "Developer" });
    const root = el(document.body, ".webpic-window");
    expect(el(root, ".webpic-window_grip")).toBeTruthy();
    expect(el(root, ".webpic-window_title").textContent).toBe("Developer");
    expect(el(root, ".webpic-window_resize").dataset.noDrag).toBe("");
    expect(win.body.classList.contains("webpic-window_body")).toBe(true);

    win.dispose();
    expect(document.body.querySelector(".webpic-window")).toBeNull();
  });

  it("retitles via setTitle (text + aria-label)", () => {
    const win = createFloatingWindow({ parent: document.body, title: "Developer" });
    win.setTitle("Diagnostics");
    expect(el(document.body, ".webpic-window_title").textContent).toBe("Diagnostics");
    expect(win.element.getAttribute("aria-label")).toBe("Diagnostics");
    win.dispose();
  });

  it("show/hide toggles the hidden attribute", () => {
    const win = createFloatingWindow({ parent: document.body, title: "Developer" });
    win.hide();
    expect(win.element.hidden).toBe(true);
    win.show();
    expect(win.element.hidden).toBe(false);
    win.dispose();
  });

  it("raises to the front on pointerdown", () => {
    const a = createFloatingWindow({ parent: document.body, title: "A" });
    const b = createFloatingWindow({ parent: document.body, title: "B" });
    expect(Number(b.element.style.zIndex)).toBeGreaterThan(Number(a.element.style.zIndex)); // newest on top

    a.element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(Number(a.element.style.zIndex)).toBeGreaterThan(Number(b.element.style.zIndex)); // grabbing A lifts it

    a.dispose();
    b.dispose();
  });
});
