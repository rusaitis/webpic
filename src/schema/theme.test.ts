import { describe, expect, it } from "vitest";
import { cssRgba, DEFAULT_WEBPIC_CONFIG, parseTheme } from "./theme.ts";

describe("parseTheme", () => {
  it("fills [webpic] defaults when the section is absent", () => {
    const theme = parseTheme(`name = "x"\n[colors]\nbackground = "#000000"`);
    expect(theme.webpic).toEqual(DEFAULT_WEBPIC_CONFIG);
  });

  it("derives the name from sourceName when the TOML omits it", () => {
    expect(parseTheme(`[colors]\nbackground = "#000000"`, "dark").name).toBe("dark");
  });

  it("normalizes a hex color to rgba-0..1", () => {
    const theme = parseTheme(`background = "#ff8040"\n` + `[colors]\nbackground = "#ff8040"`);
    expect(theme.colors.background).toEqual([1, 128 / 255, 64 / 255, 1]);
  });

  it("passes through an [r,g,b,a] float array and defaults a 3-tuple alpha to 1", () => {
    const theme = parseTheme(`[colors]\ntext = [0.298, 0.31, 0.412, 0.9]\ngrid = [0.1, 0.2, 0.3]`);
    expect(theme.colors.text).toEqual([0.298, 0.31, 0.412, 0.9]);
    expect(theme.colors.grid).toEqual([0.1, 0.2, 0.3, 1]);
  });

  it("takes the first colormap when given a preference list", () => {
    const theme = parseTheme(`[colormaps]\nsequential = ["plasma", "inferno"]`);
    expect(theme.colormaps.sequential).toBe("plasma");
    expect(theme.colormaps.diverging).toBe("RdBu_r"); // default fallback
  });

  it("ignores pypic matplotlib-only sections without throwing", () => {
    const theme = parseTheme(
      `[colors]\nbackground = "#111111"\n[lines]\nwidth = 1.5\n[progress_bar]\nheight = 4.0`,
    );
    expect(theme.colors.background).toEqual([17 / 255, 17 / 255, 17 / 255, 1]);
  });

  it("rejects an invalid docked-side enum loudly", () => {
    expect(() => parseTheme(`[webpic.layout]\ndocked-side = "up"`)).toThrow(/Invalid theme/);
  });

  it("maps kebab [webpic] keys to camelCase", () => {
    const theme = parseTheme(
      `[webpic.layout]\ndocked-side = "left"\n[webpic.diagnostics]\ntimestamp-query-overlay = true`,
    );
    expect(theme.webpic.layout.dockedSide).toBe("left");
    expect(theme.webpic.diagnostics.timestampQueryOverlay).toBe(true);
  });
});

describe("cssRgba", () => {
  it("formats rgba-0..1 as a CSS rgba() string", () => {
    expect(cssRgba([1, 0.5, 0, 0.8])).toBe("rgba(255, 128, 0, 0.8)");
  });
});
