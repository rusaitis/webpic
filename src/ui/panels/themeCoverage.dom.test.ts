import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { PANEL_REGISTRY } from "./registry.ts";

// Drift guard: a shipped theme's `default-panels` (vendored byte-for-byte from pypic via
// scripts/sync-themes.ts) must name panels webpic actually serves, or mountPanel silently renders a
// "Coming soon" placeholder. Each name must be either registered (docked via mountPanel) or listed
// here as deliberately served by another surface. An unrecognized name fails CI — fix the upstream
// pypic theme or register/allow-list the panel; do NOT hand-edit the synced TOMLs (the sync reverts).
// Loaded via import.meta.glob (the same mechanism data/theme/loader.ts uses), so no fs access.
const SERVED_ELSEWHERE = new Set([
  "colormap", // ui/colorbar/ — colormap controls live in the colorbar popover, not a docked panel
  "layers", // ui/colorbar/ — the instance-first layer list
  "dataset", // top bar
  "time", // top bar
  "scene", // left tool rail (installScenePanel, mounted directly — not via mountPanel)
]);

function isKnownPanel(name: string): boolean {
  return Object.hasOwn(PANEL_REGISTRY, name) || SERVED_ELSEWHERE.has(name);
}

const RAW_THEMES = import.meta.glob("../../data/theme/themes/*.toml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function defaultPanels(tomlText: string): readonly string[] {
  const parsed = parse(tomlText) as { webpic?: { layout?: { "default-panels"?: unknown } } };
  const panels = parsed.webpic?.layout?.["default-panels"];
  return Array.isArray(panels) ? panels.filter((p): p is string => typeof p === "string") : [];
}

describe("theme default-panels coverage", () => {
  const themes = Object.entries(RAW_THEMES);

  it("recognizes registered and served-elsewhere panels but not unknown names", () => {
    expect(isKnownPanel("field")).toBe(true); // registered (docked)
    expect(isKnownPanel("colormap")).toBe(true); // served by the colorbar
    expect(isKnownPanel("not-a-real-panel")).toBe(false); // the drift this guard catches
  });

  it("ships theme TOMLs to validate", () => {
    expect(themes.length).toBeGreaterThan(0);
  });

  for (const [path, text] of themes) {
    it(`${path}: every default-panel is registered or served elsewhere`, () => {
      for (const name of defaultPanels(text)) {
        expect(
          isKnownPanel(name),
          `theme "${path}" requests panel "${name}" — register it or add to SERVED_ELSEWHERE`,
        ).toBe(true);
      }
    });
  }
});
