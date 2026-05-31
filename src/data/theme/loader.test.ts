import { describe, expect, it } from "vitest";
import { BUNDLED_THEME_NAMES, DEFAULT_THEME_NAME, loadBundledThemes } from "./loader.ts";

describe("loadBundledThemes", () => {
  const themes = loadBundledThemes();

  it("loads all 7 bundled pypic themes", () => {
    expect(themes.size).toBe(BUNDLED_THEME_NAMES.length);
    for (const name of BUNDLED_THEME_NAMES) {
      expect(themes.has(name)).toBe(true);
    }
  });

  it("includes the default theme", () => {
    expect(themes.has(DEFAULT_THEME_NAME)).toBe(true);
  });

  it("reads per-theme [webpic] variants", () => {
    // Distinct values across themes prove the [webpic] block is parsed, not defaulted.
    expect(themes.get("lcars")?.webpic.layout.dockedSide).toBe("left");
    expect(themes.get("synthwave")?.webpic.diagnostics.timestampQueryOverlay).toBe(true);
    expect(themes.get("dark")?.webpic.layout.dockedSide).toBe("right");
  });

  it("reads cross-tool [colors] and [colormaps] sections", () => {
    const anuppuccin = themes.get("anuppuccin-light");
    expect(anuppuccin?.colormaps.sequential).toBe("inferno");
    expect(anuppuccin?.colors.cycle.length).toBeGreaterThan(0);
    expect(themes.get("synthwave")?.colormaps.sequential).toBe("plasma");
    // anuppuccin-light background "#eff1f5"
    expect(anuppuccin?.colors.background).toEqual([0xef / 255, 0xf1 / 255, 0xf5 / 255, 1]);
  });
});
