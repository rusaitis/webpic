import {
  cssRgba,
  FALLBACK_AXIS,
  type Rgba01,
  type Theme,
  type ThemeAxes,
  type ThemeColors,
} from "@schema/theme.ts";
import cameraCss from "../camera/camera.css?raw";
import coordsCardCss from "../camera/coordsCard.css?raw";
import colorbarCss from "../colorbar/colorbar.css?raw";
import controlsCss from "../controls/controls.css?raw";
import type { Disposer } from "../controls/index.ts";
import popoverCss from "../controls/popover.css?raw";
import floatingCss from "../floating/floating.css?raw";
import layersCss from "../layers/layers.css?raw";
import layerSettingsCss from "../layers/settings.css?raw";
import shellCss from "../panels/shell.css?raw";
import perfCss from "../perf/perf.css?raw";
import bootRevealCss from "../status/bootReveal.css?raw";
import statusPillCss from "../status/statusPill.css?raw";
import topbarCss from "../topbar/topbar.css?raw";
import baseCss from "./base.css?raw";
import coarsePointerCss from "./coarsePointer.css?raw";

// One stylesheet, assembled from per-surface fragments that live beside the modules they style.
// This array IS the cascade, so it is ordered by hand: base tokens, surfaces in mount order, then
// the coarse-pointer overrides, which must win over all of them.
const UI_CSS = [
  baseCss,
  bootRevealCss,
  shellCss,
  controlsCss,
  cameraCss,
  layersCss,
  coordsCardCss,
  statusPillCss,
  topbarCss,
  popoverCss,
  colorbarCss,
  floatingCss,
  layerSettingsCss,
  coarsePointerCss,
  perfCss,
].join("\n");

// One injected <style> for the whole UI (shell + controls). CSP-safe single tag
// (strict-CSP hosts get a nonce'd <link> instead). Theme colors resolve to `--webpic-*`
// custom properties on the shell root, so the cascade tracks theme changes without
// re-injecting CSS.

const STYLE_ID = "webpic-ui-styles";

function colorVar(color: Rgba01 | undefined, fallback: string): string {
  return color ? cssRgba(color) : fallback;
}

// Neutral dark palette used when a theme omits a color.
const FALLBACK_BG = "rgba(16, 24, 32, 0.94)";
const FALLBACK_FG = "#c8d0d8";
const FALLBACK_BORDER = "rgba(200, 208, 216, 0.16)";
const FALLBACK_MUTED = "#8a94a0";
const FALLBACK_ACCENT = "#5aa9e6";

// Theme-derived base palette → the five root custom properties everything else mixes from. Falls
// back to the neutral dark palette above when a theme omits a color.
function baseVars(colors: ThemeColors | undefined): Record<string, string> {
  return {
    "--webpic-bg": colorVar(colors?.background, FALLBACK_BG),
    "--webpic-fg": colorVar(colors?.text, FALLBACK_FG),
    "--webpic-muted": colorVar(colors?.secondaryText, FALLBACK_MUTED),
    "--webpic-accent": colorVar(colors?.accent, FALLBACK_ACCENT),
    "--webpic-border": colorVar(colors?.grid, FALLBACK_BORDER),
  };
}

// Axis triad → the corner gnomon's HUD colors, from theme.axes. The in-scene 3D axes resolve from
// the same FALLBACK_AXIS (schema/theme), so a recolored theme keeps the gnomon + scene in agreement.
function axisVars(axes: ThemeAxes | undefined): Record<string, string> {
  return {
    "--webpic-axis-x": colorVar(axes?.x, cssRgba(FALLBACK_AXIS.x)),
    "--webpic-axis-y": colorVar(axes?.y, cssRgba(FALLBACK_AXIS.y)),
    "--webpic-axis-z": colorVar(axes?.z, cssRgba(FALLBACK_AXIS.z)),
  };
}

// Semantic shading ladder: most rungs are a color-mix/shadow/z-index expression over the five base
// vars, so they track whatever theme is applied — one named token per surface/edge/lift/affordance
// instead of the percentages scattered through UI_CSS (plus a handful of theme-independent
// primitives at the tail: the mono stack, blur depth, ease). Set on the install root (the floating
// chrome are its siblings, not the shell's descendants) and inherited like the base vars, including the
// body-appended popover. Theme-independent (the base vars carry the theme), hence one shared record.
const DERIVED_TOKENS = {
  "--webpic-surface": "color-mix(in srgb, var(--webpic-bg) 25%, transparent)",
  "--webpic-panel": "color-mix(in srgb, var(--webpic-bg) 80%, transparent)",
  "--webpic-pop": "color-mix(in srgb, var(--webpic-bg) 92%, transparent)",
  "--webpic-edge": "color-mix(in srgb, var(--webpic-border) 45%, transparent)",
  "--webpic-edge-soft": "color-mix(in srgb, var(--webpic-border) 55%, transparent)",
  "--webpic-edge-mid": "color-mix(in srgb, var(--webpic-border) 60%, transparent)",
  "--webpic-edge-70": "color-mix(in srgb, var(--webpic-border) 70%, transparent)",
  "--webpic-edge-strong": "color-mix(in srgb, var(--webpic-border) 85%, transparent)",
  "--webpic-lift": "color-mix(in srgb, var(--webpic-fg) 4%, transparent)",
  "--webpic-lift-6": "color-mix(in srgb, var(--webpic-fg) 6%, transparent)",
  "--webpic-hover": "color-mix(in srgb, var(--webpic-fg) 10%, transparent)",
  "--webpic-active": "color-mix(in srgb, var(--webpic-accent) 20%, transparent)",
  "--webpic-active-strong": "color-mix(in srgb, var(--webpic-accent) 28%, transparent)",
  "--webpic-active-edge": "color-mix(in srgb, var(--webpic-accent) 55%, transparent)",
  "--webpic-seg-pill": "color-mix(in srgb, var(--webpic-accent) 30%, transparent)",
  "--webpic-glow": "0 0 0 2px color-mix(in srgb, var(--webpic-fg) 35%, transparent)",
  "--webpic-shadow-1": "0 6px 22px rgba(0, 0, 0, 0.22)",
  "--webpic-shadow-2": "0 10px 30px rgba(0, 0, 0, 0.34)",
  "--webpic-shadow-3": "0 12px 32px rgba(0, 0, 0, 0.36)",
  "--webpic-shadow-4": "0 16px 40px rgba(0, 0, 0, 0.4)",
  // Off-ladder fixed-black shadows: one-off depths used by a single surface each (siderail
  // pressed/tooltip, collapsed colorbar, floating window), named so the literals don't scatter
  // through UI_CSS. Same theme-independent contract as shadow-1..4.
  "--webpic-shadow-subtle": "0 1px 2px rgba(0, 0, 0, 0.15)",
  "--webpic-shadow-sm": "0 4px 14px rgba(0, 0, 0, 0.28)",
  "--webpic-shadow-mid": "0 3px 12px rgba(0, 0, 0, 0.16)",
  "--webpic-shadow-window": "0 12px 32px rgba(0, 0, 0, 0.32)",
  // Black text outlines for legibility over the gradient (the collapsed colorbar mini-label),
  // deliberately theme-independent — a light-on-light theme still needs the dark halo.
  "--webpic-text-shadow": "0 1px 2px rgba(0, 0, 0, 0.45)",
  "--webpic-text-shadow-strong": "0 1px 3px rgba(0, 0, 0, 0.75)",
  // 1px inner hairline around painted strips (swatch preview, colorbar gradient).
  "--webpic-inset-edge": "inset 0 0 0 1px var(--webpic-edge-mid)",
  "--webpic-dim": "color-mix(in srgb, var(--webpic-bg) 55%, transparent)",
  "--webpic-dim-strong": "color-mix(in srgb, var(--webpic-bg) 70%, transparent)",
  // Status error is a fixed semantic red (the theme schema has no error color); a recolored
  // axis-X must not drag it along even though the default hex coincides with the X axis.
  "--webpic-error": "#e06c75",
  // Fixed semantic amber for soft warnings (the colorbar's >2-bindings badge) — same
  // theme-independent contract as --webpic-error.
  "--webpic-warn": "#d8a13f",
  // z-index ladder (chrome stacking), names ascending with the value. Within-component z (range
  // grip, segmented seg, minilabel, the topbar reveal's local pop) stay literal — they're local
  // stacking contexts, not part of this global order.
  "--webpic-z-chrome": "9",
  "--webpic-z-shell": "10",
  "--webpic-z-status": "11",
  "--webpic-z-card": "12",
  "--webpic-z-cbar": "13",
  "--webpic-z-cbar-pop": "14",
  "--webpic-z-window": "15",
  "--webpic-z-chrome-label": "30",
  "--webpic-z-glass": "800",
  "--webpic-z-layers": "805",
  "--webpic-z-flyout": "810",
  "--webpic-z-modal": "1000",
  "--webpic-z-popover": "1100",
  // Non-color primitives shared across UI_CSS, one source each: the monospace stack, the glass
  // backdrop-blur depth, and the standard ease — so the literals don't repeat through the sheet.
  "--webpic-mono": 'ui-monospace, "SF Mono", Menlo, monospace',
  "--webpic-blur": "10px",
  "--webpic-ease": "cubic-bezier(0.25, 1, 0.5, 1)",
} as const satisfies Record<string, string>;

// Map the theme onto every UI custom property: base palette + axis triad + the derived ladder.
export function applyUiVars(root: HTMLElement, theme?: Theme): void {
  const vars = { ...baseVars(theme?.colors), ...axisVars(theme?.axes), ...DERIVED_TOKENS };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

// Inject the stylesheet (idempotent by id) and set the palette vars on `root`. Returns a
// disposer that clears the vars and removes the <style>. Assumes one install per document.
export function applyControlStyles(root: HTMLElement, theme?: Theme): Disposer {
  applyUiVars(root, theme);
  const doc = root.ownerDocument;
  let style = doc.getElementById(STYLE_ID);
  const owned = style === null;
  if (style === null) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = UI_CSS;
    doc.head.appendChild(style);
  }
  return () => {
    for (const name of UI_VARS) root.style.removeProperty(name);
    if (owned) style.remove();
  };
}

// Every property name applyUiVars writes, derived from the same builders so the cleared set can't
// drift from the written set — a set-but-not-cleared token would leak onto document.body across
// re-installs (embeds/tests). The builders return all keys regardless of input, so undefined args
// yield the full key set.
const UI_VARS: readonly string[] = Object.keys({
  ...baseVars(undefined),
  ...axisVars(undefined),
  ...DERIVED_TOKENS,
});
