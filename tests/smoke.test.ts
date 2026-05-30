import { describe, expect, it } from "vitest";

describe("toolchain smoke", () => {
  it("runs vitest in node mode", () => {
    expect(1 + 1).toBe(2);
  });
});
