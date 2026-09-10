import { afterEach, describe, expect, it } from "vitest";
import { bringToFront, installRaise, Z_FLOATING_BASE } from "./zStack.ts";

function raiser(signal?: AbortSignal) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const dispose = installRaise(el, signal);
  const press = (): void => {
    el.dispatchEvent(new Event("pointerdown"));
  };
  return { el, dispose, press };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("zStack", () => {
  it("each raise takes the next z above the floating base, most recent on top", () => {
    const a = raiser();
    const b = raiser();
    a.press();
    b.press();
    a.press();
    expect(a.el.style.zIndex).toBe(`${Z_FLOATING_BASE + 3}`);
    expect(b.el.style.zIndex).toBe(`${Z_FLOATING_BASE + 2}`);
    a.dispose();
    b.dispose();
  });

  it("returns to the base once the last raiser releases — by disposer or by signal", () => {
    const a = raiser();
    const ac = new AbortController();
    const b = raiser(ac.signal);
    a.press();
    b.press();
    expect(b.el.style.zIndex).toBe(`${Z_FLOATING_BASE + 2}`);

    a.dispose();
    a.dispose(); // idempotent: b still holds the stack open, so no reset yet
    b.press();
    expect(b.el.style.zIndex).toBe(`${Z_FLOATING_BASE + 3}`);

    ac.abort();
    const c = raiser();
    c.press();
    expect(c.el.style.zIndex).toBe(`${Z_FLOATING_BASE + 1}`);
    c.dispose();
  });

  it("a released raiser no longer lifts; bringToFront rides the same counter", () => {
    const a = raiser();
    a.dispose();
    a.press();
    expect(a.el.style.zIndex).toBe("");

    const b = raiser();
    bringToFront(b.el);
    expect(b.el.style.zIndex).toBe(`${Z_FLOATING_BASE + 1}`);
    b.press();
    expect(b.el.style.zIndex).toBe(`${Z_FLOATING_BASE + 2}`);
    b.dispose();
  });

  it("ignores an already-aborted signal without counting a dead raiser", () => {
    const ac = new AbortController();
    ac.abort();
    const dead = raiser(ac.signal);
    dead.press();
    expect(dead.el.style.zIndex).toBe("");
    const live = raiser();
    live.dispose(); // the only counted raiser → reset
    const next = raiser();
    next.press();
    expect(next.el.style.zIndex).toBe(`${Z_FLOATING_BASE + 1}`);
    next.dispose();
  });
});
