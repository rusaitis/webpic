import { describe, expect, it } from "vitest";
import * as ops from "./colormap.ts";

const base = () =>
  ops.upsertBinding({}, ops.makeDefaultBinding("b0", "|B|", { center: 5, width: 2 }));

describe("colormap binding ops", () => {
  it("makeDefaultBinding uses the default colormap + linear scale + given window", () => {
    expect(ops.makeDefaultBinding("b0", "|B|", { center: 5, width: 2 })).toEqual({
      id: "b0",
      field: "|B|",
      colormap: "inferno",
      scale: "linear",
      window: { center: 5, width: 2 },
    });
  });

  it("setBindingColormap returns a fresh record + binding, leaving the input untouched", () => {
    const rec = base();
    const next = ops.setBindingColormap(rec, "b0", "viridis");
    expect(next).not.toBe(rec);
    expect(next.b0?.colormap).toBe("viridis");
    expect(rec.b0?.colormap).toBe("inferno"); // input not mutated
  });

  it("identity (same reference) on a no-op colormap change", () => {
    const rec = base();
    expect(ops.setBindingColormap(rec, "b0", "inferno")).toBe(rec);
  });

  it("a missing id is an identity no-op for every patch", () => {
    const rec = base();
    expect(ops.setBindingColormap(rec, "nope", "viridis")).toBe(rec);
    expect(ops.setBindingWindow(rec, "nope", 1, 1)).toBe(rec);
    expect(ops.setBindingScale(rec, "nope", "log")).toBe(rec);
    expect(ops.retargetBinding(rec, "nope", "|E|", { center: 0, width: 1 })).toBe(rec);
  });

  it("setBindingWindow patches center+width, identity on a no-op", () => {
    const rec = base();
    const next = ops.setBindingWindow(rec, "b0", 3, 4);
    expect(next.b0?.window).toEqual({ center: 3, width: 4 });
    expect(ops.setBindingWindow(next, "b0", 3, 4)).toBe(next);
  });

  it("setBindingScale patches scale, identity on a no-op", () => {
    const rec = base();
    const next = ops.setBindingScale(rec, "b0", "symlog");
    expect(next.b0?.scale).toBe("symlog");
    expect(ops.setBindingScale(next, "b0", "symlog")).toBe(next);
  });

  it("retargetBinding swaps field+window but keeps the colormap + scale", () => {
    const rec = ops.setBindingScale(ops.setBindingColormap(base(), "b0", "magma"), "b0", "log");
    const next = ops.retargetBinding(rec, "b0", "|E|", { center: 10, width: 1 });
    expect(next.b0).toMatchObject({
      field: "|E|",
      window: { center: 10, width: 1 },
      colormap: "magma",
      scale: "log",
    });
  });
});
