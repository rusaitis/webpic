import { cssRgba, type Rgba01, type ThemeColors } from "@schema/theme.ts";
import type { Disposer } from "../controls/index.ts";

// One injected <style> for the whole UI (shell + controls). CSP-safe single tag
// (strict-CSP hosts get a nonce'd <link> instead). Theme colors resolve to `--webpic-*`
// custom properties on the shell root, so the cascade tracks theme changes without
// re-injecting CSS.

const STYLE_ID = "webpic-ui-styles";

function colorVar(color: Rgba01 | undefined, fallback: string): string {
  return color ? cssRgba(color) : fallback;
}

// Map the themed palette onto the UI vars; fall back to a neutral dark palette when a
// theme omits a color.
export function applyUiVars(root: HTMLElement, colors: ThemeColors | undefined): void {
  root.style.setProperty("--webpic-bg", colorVar(colors?.background, "rgba(16, 24, 32, 0.94)"));
  root.style.setProperty("--webpic-fg", colorVar(colors?.text, "#c8d0d8"));
  root.style.setProperty("--webpic-muted", colorVar(colors?.secondaryText, "#8a94a0"));
  root.style.setProperty("--webpic-accent", colorVar(colors?.accent, "#5aa9e6"));
  root.style.setProperty("--webpic-border", colorVar(colors?.grid, "rgba(200, 208, 216, 0.16)"));
}

// Inject the stylesheet (idempotent by id) and set the palette vars on `root`. Returns a
// disposer that clears the vars and removes the <style>. Assumes one install per document.
export function applyControlStyles(root: HTMLElement, colors?: ThemeColors): Disposer {
  applyUiVars(root, colors);
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

const UI_VARS = [
  "--webpic-bg",
  "--webpic-fg",
  "--webpic-muted",
  "--webpic-accent",
  "--webpic-border",
];

const UI_CSS = `
.webpic-shell {
  position: fixed; top: 12px; bottom: 12px; width: 268px; z-index: 10;
  display: flex; flex-direction: column; gap: 8px; overflow-y: auto;
  padding: 10px; box-sizing: border-box;
  background: var(--webpic-bg); color: var(--webpic-fg);
  border: 1px solid var(--webpic-border); border-radius: 8px;
  font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  --webpic-input-bg: rgba(0, 0, 0, 0.28);
  --webpic-radius: 4px; --webpic-unit: 22px;
}
.webpic-shell[data-side="left"] { left: 12px; }
.webpic-shell[data-side="right"] { right: 12px; }
.webpic-shell[hidden] { display: none; }
.webpic-pane { display: flex; flex-direction: column; }
.webpic-pane_title { font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--webpic-muted); padding: 2px 4px 6px; }
.webpic-folder { border-top: 1px solid var(--webpic-border); }
.webpic-folder_bar { display: block; width: 100%; margin: 0; padding: 6px 4px; border: 0;
  background: transparent; color: var(--webpic-fg); font: inherit; font-weight: 600;
  text-align: left; cursor: pointer; }
.webpic-folder_body { display: flex; flex-direction: column; gap: 6px; padding: 0 0 8px; }
.webpic-folder_body[hidden] { display: none; }
.webpic-row { display: flex; align-items: center; padding: 0 4px; }
.webpic-row_label { flex: 1; overflow: hidden; text-overflow: ellipsis; color: var(--webpic-muted);
  padding-right: 10px; }
.webpic-row_value { flex: 0 0 132px; }
.webpic-checkbox { display: block; position: relative; width: var(--webpic-unit);
  height: var(--webpic-unit); }
.webpic-checkbox_input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
.webpic-checkbox_box { width: var(--webpic-unit); height: var(--webpic-unit);
  background: var(--webpic-input-bg); border-radius: var(--webpic-radius); }
.webpic-checkbox_box svg { display: block; width: 100%; height: 100%; opacity: 0; }
.webpic-checkbox_input:checked + .webpic-checkbox_box svg { opacity: 1; }
.webpic-checkbox_box svg path { fill: none; stroke: var(--webpic-accent); stroke-width: 2; }
.webpic-select, .webpic-text { box-sizing: border-box; width: 100%; height: var(--webpic-unit);
  padding: 0 6px; border: 1px solid var(--webpic-border); border-radius: var(--webpic-radius);
  background: var(--webpic-input-bg); color: var(--webpic-fg); font: inherit; }
.webpic-text { text-align: right; }
.webpic-slider { display: flex; align-items: center; gap: 6px; width: 100%; }
.webpic-slider_input { flex: 1; min-width: 0; accent-color: var(--webpic-accent); }
.webpic-slider_readout { flex: 0 0 auto; min-width: 36px; text-align: right; color: var(--webpic-muted); }
.webpic-button_btn { width: 100%; height: var(--webpic-unit); border: 1px solid var(--webpic-border);
  border-radius: var(--webpic-radius); background: var(--webpic-input-bg); color: var(--webpic-fg);
  font: inherit; cursor: pointer; }
.webpic-shell :disabled { opacity: 0.5; cursor: default; }
.webpic-placeholder { padding: 2px 4px; color: var(--webpic-muted); font-style: italic; }
`;
