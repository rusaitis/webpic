import { afterEach, describe, expect, it } from "vitest";
import { createShortcutRegistry, type ShortcutRegistry } from "./shortcuts.ts";

const registries: ShortcutRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  document.body.replaceChildren();
});

function registry(signal?: AbortSignal): ShortcutRegistry {
  const r = createShortcutRegistry(document, signal);
  registries.push(r);
  return r;
}

function press(init: KeyboardEventInit, target: EventTarget = document): boolean {
  return target.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init }));
}

describe("createShortcutRegistry", () => {
  it("matches the layout key case-insensitively and claims the event", () => {
    let fired = 0;
    registry().register("f", () => fired++);
    expect(press({ key: "F" })).toBe(false); // preventDefault'ed
    expect(press({ key: "f" })).toBe(false);
    expect(fired).toBe(2);
    expect(press({ key: "g" })).toBe(true);
    expect(fired).toBe(2);
  });

  it("matches the physical key by code when the layout key is absent", () => {
    let fired = 0;
    registry().register("KeyC", () => fired++);
    press({ code: "KeyC" });
    press({ code: "Digit1" });
    expect(fired).toBe(1);
  });

  it("applies the shared guards: typing targets, OS chords, handled events, Shift by default", () => {
    let fired = 0;
    registry().register("r", () => fired++);
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.appendChild(editor);
    press({ key: "r", bubbles: true }, editor);
    press({ key: "r", metaKey: true });
    press({ key: "r", ctrlKey: true });
    press({ key: "r", altKey: true });
    press({ key: "R", shiftKey: true });
    const handled = new KeyboardEvent("keydown", { key: "r", cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(fired).toBe(0);
    press({ key: "r" });
    expect(fired).toBe(1);
  });

  it("modifiers: 'shift' requires Shift, 'any' ignores it", () => {
    const seen: string[] = [];
    const r = registry();
    r.register("p", () => seen.push("shift+p"), { modifiers: "shift" });
    r.register("KeyH", () => seen.push("h"), { modifiers: "any" });
    press({ key: "p" });
    press({ key: "P", shiftKey: true });
    press({ code: "KeyH" });
    press({ code: "KeyH", shiftKey: true });
    expect(seen).toEqual(["shift+p", "h", "h"]);
  });

  it("fires one binding per event — the first match wins", () => {
    let fired = 0;
    const r = registry();
    r.register("?", () => fired++, { modifiers: "shift" });
    r.register("Slash", () => fired++, { modifiers: "shift" });
    press({ key: "?", code: "Slash", shiftKey: true }); // matches both by key and by code
    expect(fired).toBe(1);
  });

  it("stops on dispose and on an aborted signal", () => {
    let fired = 0;
    const r = registry();
    r.register("z", () => fired++);
    r.dispose();
    press({ key: "z" });
    const abortController = new AbortController();
    registry(abortController.signal).register("z", () => fired++);
    abortController.abort();
    press({ key: "z" });
    expect(fired).toBe(0);
  });
});
