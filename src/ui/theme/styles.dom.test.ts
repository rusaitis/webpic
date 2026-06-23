import { parseTheme } from "@schema/theme.ts";
import { afterEach, describe, expect, it } from "vitest";
import { applyControlStyles } from "./styles.ts";

afterEach(() => {
  document.getElementById("webpic-ui-styles")?.remove();
});

describe("applyControlStyles theme vars", () => {
  it("derives the gnomon axis vars from theme.axes (the same source as the 3D scene)", () => {
    const root = document.createElement("div");
    const dispose = applyControlStyles(root, parseTheme('[axes]\nx_color = "#112233"\n', "test"));
    // theme.axes.x drives --webpic-axis-x; y/z fall back to the canonical FALLBACK_AXIS palette.
    expect(root.style.getPropertyValue("--webpic-axis-x")).toBe("rgba(17, 34, 51, 1)");
    expect(root.style.getPropertyValue("--webpic-axis-y")).toBe("rgba(152, 195, 121, 1)");
    expect(root.style.getPropertyValue("--webpic-axis-z")).toBe("rgba(97, 175, 239, 1)");
    dispose();
  });

  it("falls back to the canonical axis palette when the theme omits axis colors", () => {
    const root = document.createElement("div");
    const dispose = applyControlStyles(root, parseTheme("", "empty"));
    expect(root.style.getPropertyValue("--webpic-axis-x")).toBe("rgba(224, 108, 117, 1)");
    dispose();
  });

  it("sets the derived shading tokens and clears every var on dispose", () => {
    const root = document.createElement("div");
    const dispose = applyControlStyles(root); // no theme — neutral fallback palette
    expect(root.style.getPropertyValue("--webpic-surface")).toContain("var(--webpic-bg)");
    expect(root.style.getPropertyValue("--webpic-z-window")).toBe("15");
    dispose();
    for (const name of [
      "--webpic-bg",
      "--webpic-axis-x",
      "--webpic-surface",
      "--webpic-z-window",
    ]) {
      expect(root.style.getPropertyValue(name)).toBe("");
    }
  });
});
