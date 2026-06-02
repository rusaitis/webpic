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
.webpic-range { --gs: 13px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; width: 100%; }
.webpic-range.is-disabled { opacity: 0.5; pointer-events: none; }
.webpic-range_track { position: relative; flex: 1 1 100%; min-width: 0; margin: 0 calc(var(--gs) / 2);
  height: var(--gs); background: transparent; touch-action: none; cursor: pointer; }
.webpic-range_track::before { content: ""; position: absolute; top: 50%; left: 0; right: 0; height: 4px;
  transform: translateY(-50%); background: var(--webpic-border); border-radius: var(--webpic-radius);
  pointer-events: none; }
.webpic-range_fill { position: absolute; top: 50%; transform: translateY(-50%); height: 4px;
  left: calc(var(--fa, 0) * 100%); width: calc((var(--fb, 0) - var(--fa, 0)) * 100%);
  background: var(--webpic-accent); border-radius: var(--webpic-radius); pointer-events: none; }
.webpic-range_fill[data-origin="left"] { border-top-left-radius: 0; border-bottom-left-radius: 0; }
.webpic-range_fill[data-origin="right"] { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.webpic-range_ticks { position: absolute; inset: 0; pointer-events: none; }
.webpic-range_tick { position: absolute; top: 50%; width: 1px; height: calc(var(--gs) * 2 / 3);
  transform: translate(-50%, -50%); left: calc(var(--mt) * 100%); background: var(--webpic-muted); }
.webpic-range_tick.is-minor { height: calc(var(--gs) / 3);
  background: color-mix(in srgb, var(--webpic-muted) 45%, transparent); }
.webpic-range_grip { position: absolute; top: 50%; width: var(--gs); height: var(--gs);
  transform: translate(-50%, -50%); background: var(--webpic-input-bg); border-radius: var(--webpic-radius);
  touch-action: none; cursor: grab; z-index: 1; }
.webpic-range_grip[data-end="value"] { left: calc(var(--t, 0) * 100%); }
.webpic-range_grip[data-end="lo"] { left: calc(var(--tlo, 0) * 100%); }
.webpic-range_grip[data-end="hi"] { left: calc(var(--thi, 1) * 100%); }
.webpic-range_grip::before { content: ""; position: absolute; inset: -8px; }
.webpic-range_grip::after { content: ""; position: absolute; top: 50%; left: 50%;
  width: calc(var(--gs) / 2); height: calc(var(--gs) / 2); transform: translate(-50%, -50%);
  background: var(--webpic-accent); border-radius: calc(var(--webpic-radius) / 2); pointer-events: none; }
.webpic-range_grip:focus-visible { outline: 1px solid color-mix(in srgb, var(--webpic-accent) 40%, transparent);
  outline-offset: 2px; }
.webpic-range.is-dragging .webpic-range_grip { cursor: grabbing; }
.webpic-range_text { display: flex; gap: 4px; flex: 1 1 100%; justify-content: flex-end; }
.webpic-range_input { width: 100%; min-width: 0; box-sizing: border-box; padding: 0 4px;
  height: var(--webpic-unit); border: 1px solid var(--webpic-border); border-radius: var(--webpic-radius);
  background: var(--webpic-input-bg); color: var(--webpic-fg); font: inherit; text-align: right; }
.webpic-button_btn { width: 100%; height: var(--webpic-unit); border: 1px solid var(--webpic-border);
  border-radius: var(--webpic-radius); background: var(--webpic-input-bg); color: var(--webpic-fg);
  font: inherit; cursor: pointer; }
.webpic-shell :disabled { opacity: 0.5; cursor: default; }
.webpic-placeholder { padding: 2px 4px; color: var(--webpic-muted); font-style: italic; }
`;
