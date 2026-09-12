import { afterEach, describe, expect, it } from "vitest";
import { createHeldKeys, type HeldKeysOptions } from "./heldKeys.ts";

const controllers: AbortController[] = [];
afterEach(() => {
  for (const abortController of controllers.splice(0)) abortController.abort();
  document.body.replaceChildren();
});

function setup(options: Partial<HeldKeysOptions> = {}) {
  const abortController = new AbortController();
  controllers.push(abortController);
  const presses: string[] = [];
  let releases = 0;
  const held = createHeldKeys(document, new Set(["KeyA", "KeyD"]), {
    signal: abortController.signal,
    onPress: (event) => presses.push(event.code),
    onRelease: () => releases++,
    ...options,
  });
  return { held, presses, releases: () => releases };
}

function key(type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { code, cancelable: true, ...init });
}

describe("createHeldKeys", () => {
  it("claims a listed key on keydown and releases it on keyup", () => {
    const { held, presses, releases } = setup();
    expect(document.dispatchEvent(key("keydown", "KeyA"))).toBe(false); // claimed — preventDefault'ed
    expect([...held.codes]).toEqual(["KeyA"]);
    expect(presses).toEqual(["KeyA"]);
    document.dispatchEvent(key("keydown", "KeyA")); // OS key-repeat re-presses, never re-adds
    expect(held.codes.size).toBe(1);
    expect(presses).toEqual(["KeyA", "KeyA"]);
    document.dispatchEvent(key("keyup", "KeyA"));
    expect(held.codes.size).toBe(0);
    expect(releases()).toBe(1);
    document.dispatchEvent(key("keyup", "KeyA")); // a stray keyup releases nothing
    expect(releases()).toBe(1);
  });

  it("leaves unlisted keys, vetoed claims, and typing surfaces to the page", () => {
    const { held, presses } = setup({ claims: (event) => event.code !== "KeyD" });
    expect(document.dispatchEvent(key("keydown", "KeyZ"))).toBe(true);
    expect(document.dispatchEvent(key("keydown", "KeyD"))).toBe(true); // vetoed
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(input.dispatchEvent(key("keydown", "KeyA", { bubbles: true }))).toBe(true);
    expect(held.codes.size).toBe(0);
    expect(presses).toEqual([]);
  });

  it("drops the whole set on a Meta chord and on window blur", () => {
    const { held, releases } = setup();
    document.dispatchEvent(key("keydown", "KeyA"));
    document.dispatchEvent(key("keydown", "KeyD"));
    document.dispatchEvent(key("keydown", "MetaLeft", { metaKey: true }));
    expect(held.codes.size).toBe(0);
    expect(releases()).toBe(1); // one release for the drop, not one per key
    document.dispatchEvent(key("keydown", "KeyA"));
    window.dispatchEvent(new Event("blur"));
    expect(held.codes.size).toBe(0);
    expect(releases()).toBe(2);
    window.dispatchEvent(new Event("blur")); // nothing held — no release
    expect(releases()).toBe(2);
  });

  it("treats an unclaimed shifted keydown as a chord only when asked", () => {
    const plain = setup();
    document.dispatchEvent(key("keydown", "KeyA"));
    document.dispatchEvent(key("keydown", "ShiftLeft", { shiftKey: true }));
    expect(plain.held.codes.size).toBe(1); // KeyA still held — a bare Shift is no chord here
    expect(plain.held.isShiftHeld).toBe(true);
    plain.held.drop();
    expect(plain.releases()).toBe(1);

    const strict = setup({ shiftIsChord: true });
    document.dispatchEvent(key("keydown", "KeyA"));
    document.dispatchEvent(key("keydown", "ShiftLeft", { shiftKey: true }));
    expect(strict.held.codes.size).toBe(0);
    document.dispatchEvent(key("keyup", "ShiftLeft"));
    expect(strict.held.isShiftHeld).toBe(false);
  });
});
