import type { ColormapBinding } from "@schema/colormap.ts";
import { describe, expect, it } from "vitest";
import { colorbarStack, MAX_COLORBARS } from "./colorbarStack.ts";

const binding = (id: string): ColormapBinding => ({
  id,
  field: `F_${id}`,
  colormap: "inferno",
  window: { center: 0.5, width: 1 },
  scale: "linear",
});

describe("colorbarStack", () => {
  it("passes through up to MAX_COLORBARS bindings with no overflow", () => {
    expect(colorbarStack([], null)).toEqual({ slots: [], overflow: [] });
    const one = [binding("a")];
    expect(colorbarStack(one, null)).toEqual({ slots: one, overflow: [] });
    const two = [binding("a"), binding("b")];
    expect(colorbarStack(two, "b")).toEqual({ slots: two, overflow: [] });
  });

  it("overflows past MAX_COLORBARS in draw order", () => {
    const [a, b, c, d] = [binding("a"), binding("b"), binding("c"), binding("d")];
    const stack = colorbarStack([a, b, c, d], "a");
    expect(stack.slots).toEqual([a, b]);
    expect(stack.overflow).toEqual([c, d]);
    expect(stack.slots.length).toBe(MAX_COLORBARS);
  });

  it("guarantees the active binding a slot, displacing the last one", () => {
    const [a, b, c] = [binding("a"), binding("b"), binding("c")];
    const stack = colorbarStack([a, b, c], "c");
    expect(stack.slots).toEqual([a, c]); // c takes b's slot so the gear edits a visible strip
    expect(stack.overflow).toEqual([b]);
  });

  it("leaves the slots alone when the active binding is absent or already slotted", () => {
    const [a, b, c] = [binding("a"), binding("b"), binding("c")];
    expect(colorbarStack([a, b, c], null).slots).toEqual([a, b]);
    expect(colorbarStack([a, b, c], "nope").slots).toEqual([a, b]);
    expect(colorbarStack([a, b, c], "a").slots).toEqual([a, b]);
  });
});
