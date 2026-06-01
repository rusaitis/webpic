import { parseTheme, type Theme } from "@schema";

// Bundled themes: synced verbatim from pypic by scripts/sync-themes.ts and inlined at
// build time (no runtime fetch — keeps the cold-start budget). Custom themes go
// through parseTheme() directly (e.g. a user file drop; the picker UI is the theme switcher).
const RAW_THEMES = import.meta.glob("./themes/*.toml", {
  query: "?raw",
  import: "default",
  eager: true,
  // ?raw + eager yields raw file strings, but glob's generic return type is Record<string, unknown>.
}) as Record<string, string>;

export const DEFAULT_THEME_NAME = "dark";

export const BUNDLED_THEME_NAMES = [
  "andromeda",
  "anuppuccin-light",
  "catppuccin-mocha",
  "dark",
  "lcars",
  "light",
  "synthwave",
] as const;

export type BundledThemeName = (typeof BUNDLED_THEME_NAMES)[number];

function themeNameFromPath(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.toml$/, "");
}

/** Parse every bundled theme TOML, keyed by theme name. Throws if any is invalid. */
export function loadBundledThemes(): Map<string, Theme> {
  const themes = new Map<string, Theme>();
  for (const [path, text] of Object.entries(RAW_THEMES)) {
    const fallbackName = themeNameFromPath(path);
    const theme = parseTheme(text, fallbackName);
    themes.set(theme.name, theme);
  }
  return themes;
}

export { parseTheme, type Theme } from "@schema";
