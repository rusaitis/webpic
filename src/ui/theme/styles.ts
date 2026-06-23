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
  transition: opacity 240ms ease;
}
/* Cold-start reveal (ui/bootReveal.ts): chrome held invisible while the boot phase is live,
   fading in when the class drops. visibility (not pointer-events) so the gnomon tips' own
   pointer-events: auto can't reach through. The status pill is deliberately not matched. */
.webpic-booting .webpic-shell, .webpic-booting .webpic-chrome, .webpic-booting .webpic-rail,
.webpic-booting .webpic-siderail, .webpic-booting .webpic-topbar, .webpic-booting .webpic-cbar,
.webpic-booting .webpic-window {
  opacity: 0; visibility: hidden; }
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
.webpic-range { --gs: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; width: 100%; }
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
/* Swatch select (ui/controls/swatchSelect): a gradient-preview trigger that opens a createPopover
   list of painted rows. The trigger's canvas grows to fill; name + caret trail on the right. */
.webpic-swatch { box-sizing: border-box; width: 100%; height: var(--webpic-unit); display: flex;
  align-items: center; gap: 7px; padding: 0 6px; border: 1px solid var(--webpic-border);
  border-radius: var(--webpic-radius); background: var(--webpic-input-bg); color: var(--webpic-fg);
  font: inherit; cursor: pointer; }
.webpic-swatch:hover, .webpic-swatch:focus-visible { outline: none;
  border-color: color-mix(in srgb, var(--webpic-accent) 50%, var(--webpic-border)); }
.webpic-swatch_canvas { flex: 1 1 auto; min-width: 0; height: 12px; border-radius: 2px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--webpic-border) 60%, transparent); }
.webpic-swatch_name { flex: 0 0 auto; color: var(--webpic-muted); }
.webpic-swatch_caret { flex: 0 0 auto; display: grid; place-items: center; color: var(--webpic-muted);
  transition: transform .15s ease; }
.webpic-swatch_caret svg { display: block; width: 12px; height: 12px; fill: none; stroke: currentColor;
  stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.webpic-swatch[aria-expanded="true"] .webpic-swatch_caret { transform: rotate(180deg); }
/* Segmented sliding pill (ui/controls/segmented): equal-width radios over a highlight that slides via
   --seg-index (one column width per step); --seg-count sizes both the grid and the pill. */
.webpic-segmented { position: relative; box-sizing: border-box; width: 100%; height: var(--webpic-unit);
  display: grid; grid-template-columns: repeat(var(--seg-count, 1), 1fr); padding: 2px;
  background: var(--webpic-input-bg); border: 1px solid var(--webpic-border);
  border-radius: var(--webpic-radius); }
.webpic-segmented_pill { position: absolute; top: 2px; bottom: 2px; left: 2px;
  width: calc((100% - 4px) / var(--seg-count, 1)); border-radius: calc(var(--webpic-radius) - 1px);
  background: color-mix(in srgb, var(--webpic-accent) 30%, transparent); pointer-events: none;
  transform: translateX(calc(var(--seg-index, 0) * 100%));
  transition: transform .18s cubic-bezier(.4, 0, .2, 1); }
.webpic-segmented_seg { position: relative; z-index: 1; display: grid; place-items: center; padding: 0;
  border: 0; background: transparent; color: var(--webpic-muted); font: inherit; cursor: pointer;
  transition: color .15s ease; }
.webpic-segmented_seg[aria-checked="true"] { color: var(--webpic-fg); }
.webpic-segmented_seg:focus-visible { outline: none; color: var(--webpic-fg); }
.webpic-segmented.is-disabled { opacity: 0.5; pointer-events: none; }
.webpic-chrome { position: fixed; left: 12px; bottom: 12px; z-index: 9; pointer-events: none;
  transition: opacity 240ms ease; }
.webpic-chrome[hidden] { display: none; }
.webpic-gnomon { position: relative; flex: 0 0 auto; width: 56px; height: 56px; perspective: 220px; }
.webpic-gnomon_scene { position: absolute; inset: 0; transform-style: preserve-3d;
  transform-origin: 50% 50%; }
.webpic-gnomon_axis { position: absolute; top: 50%; left: 50%; width: 24px; height: 2px;
  transform-origin: 0 50%; border-radius: 1px; }
.webpic-gnomon_axis.is-x { transform: rotateZ(0deg); background: #e06c75; }   /* +x right */
.webpic-gnomon_axis.is-y { transform: rotateY(90deg); background: #98c379; }  /* +y into screen */
.webpic-gnomon_axis.is-z { transform: rotateZ(-90deg); background: #61afef; } /* +z up (z-up world) */
/* Clickable ±axis tips (snap-to-view): filled = positive, ring = negative. The chrome overlay is
   pointer-events: none, so tips opt back in. Their transforms are JS-owned (position + a counter-
   rotation keeping the discs screen-facing), hence a halo hover affordance rather than a scale. */
.webpic-gnomon_tip { position: absolute; top: 50%; left: 50%; width: 12px; height: 12px;
  margin: -6px 0 0 -6px; border-radius: 50%; box-sizing: border-box;
  border: 2px solid transparent; cursor: pointer; pointer-events: auto; }
.webpic-gnomon_tip:hover { box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35); }
.webpic-gnomon_tip.is-px { background: #e06c75; }
.webpic-gnomon_tip.is-nx { border-color: #e06c75; }
.webpic-gnomon_tip.is-py { background: #98c379; }
.webpic-gnomon_tip.is-ny { border-color: #98c379; }
.webpic-gnomon_tip.is-pz { background: #61afef; }
.webpic-gnomon_tip.is-nz { border-color: #61afef; }
/* Centered bottom button rail (ui/cameraRail): subtle magviz-style icon toggles. pointer-events:
   none on the bar so it never blocks the canvas — each button opts back in. has-gnomon reserves the
   bottom-left gnomon's footprint (12 + 56 + 12) symmetrically, keeping the cluster centered + clear. */
.webpic-rail { position: fixed; left: 0; right: 0; bottom: calc(12px + env(safe-area-inset-bottom));
  z-index: 9; pointer-events: none;
  display: flex; justify-content: center; align-items: center; gap: 6px;
  /* The colorbar slides the centered cluster aside (via --webpic-rail-shift) when it docks beside the
     rail, so the two read as one centered group; 0 = the rail owns the center alone. */
  transform: translateX(var(--webpic-rail-shift, 0px));
  transition: opacity 240ms ease, transform .3s cubic-bezier(0.25, 1, 0.5, 1); }
.webpic-rail[hidden] { display: none; }
.webpic-rail.has-gnomon { padding: 0 80px; }
.webpic-rail_btn { box-sizing: border-box; width: 32px; height: 32px; padding: 0;
  display: grid; place-items: center; pointer-events: auto; cursor: pointer; opacity: 0.4;
  background: transparent; color: var(--webpic-fg);
  border: 1px solid var(--webpic-border); border-radius: 6px;
  transition: opacity .15s ease, background .15s ease, border-color .15s ease; }
.webpic-rail_btn:hover, .webpic-rail_btn:focus-visible { opacity: 1; outline: none;
  background: color-mix(in srgb, var(--webpic-fg) 10%, transparent); }
.webpic-rail_btn[aria-pressed="true"], .webpic-rail_btn.is-copied { opacity: 1;
  border-color: color-mix(in srgb, var(--webpic-accent) 55%, transparent);
  background: color-mix(in srgb, var(--webpic-accent) 20%, transparent); }
.webpic-rail_btn svg { display: block; width: 16px; height: 16px; fill: none;
  stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
/* Coordinate chip: a text button (geometry · field units) that opens the grid-info card — auto width
   instead of the 30px icon square, single-line with ellipsis. aria-expanded reuses the pressed
   accent-tint while the card is open. */
.webpic-rail_coords { display: block; width: auto; min-width: 32px; max-width: 40vw; padding: 0 9px;
  font: 500 11px/30px ui-monospace, "SF Mono", Menlo, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.webpic-rail_coords[aria-expanded="true"] { opacity: 1;
  border-color: color-mix(in srgb, var(--webpic-accent) 55%, transparent);
  background: color-mix(in srgb, var(--webpic-accent) 20%, transparent); }
/* Left tool rail (ui/sideRail): a magviz-style glass card of flush, borderless icon tabs on the left
   edge, vertically centered — the instance-first rail's first occupants (View/Scene, Probe), kept
   distinct from the data layers. Shares the topbar's glass treatment (blur + bg lift on hover) so the
   chrome reads as one family; each tab's slide-out label is its aria-label (the ::after pill). */
.webpic-siderail { position: fixed; left: calc(8px + env(safe-area-inset-left)); top: 50%;
  transform: translateY(-50%); z-index: 800; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 2px; padding: 3px;
  background: color-mix(in srgb, var(--webpic-bg) 25%, transparent);
  border: 1px solid color-mix(in srgb, var(--webpic-border) 45%, transparent);
  border-radius: 12px;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.22);
  transition: opacity 240ms ease, background .18s ease, border-color .18s ease, box-shadow .18s ease; }
.webpic-siderail[hidden] { display: none; }
.webpic-siderail:hover, .webpic-siderail:focus-within {
  background: color-mix(in srgb, var(--webpic-bg) 92%, transparent);
  border-color: color-mix(in srgb, var(--webpic-border) 85%, transparent);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34); }
.webpic-siderail_btn { position: relative; box-sizing: border-box; width: 36px; height: 36px; padding: 0;
  display: grid; place-items: center; cursor: pointer; opacity: 0.65;
  background: transparent; color: var(--webpic-muted); border: none; border-radius: 7px;
  transition: opacity .12s ease, background .12s ease, color .12s ease; }
.webpic-siderail_btn:hover, .webpic-siderail_btn:focus-visible { opacity: 1; outline: none;
  color: var(--webpic-fg); background: color-mix(in srgb, var(--webpic-fg) 8%, transparent); }
.webpic-siderail_btn[aria-pressed="true"] { opacity: 1; color: var(--webpic-fg);
  background: color-mix(in srgb, var(--webpic-accent) 28%, transparent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15); }
.webpic-siderail_btn svg { display: block; width: 18px; height: 18px; fill: none;
  stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
/* Slide-out label on hover/focus (magviz's rail tooltip): the tab's aria-label as a glass pill to the
   right, after a short delay so a quick mouseover doesn't flash it. */
.webpic-siderail_btn::after { content: attr(aria-label); position: absolute; left: calc(100% + 12px);
  top: 50%; transform: translate(-6px, -50%); padding: 5px 10px; white-space: nowrap;
  background: color-mix(in srgb, var(--webpic-bg) 92%, transparent);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--webpic-border) 85%, transparent); border-radius: 7px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28); color: var(--webpic-fg);
  font: 500 11px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.03em;
  opacity: 0; pointer-events: none; z-index: 30;
  transition: opacity 140ms ease, transform 140ms ease; }
.webpic-siderail_btn:hover::after, .webpic-siderail_btn:focus-visible::after {
  opacity: 1; transform: translate(0, -50%); transition-delay: 200ms; }
/* Suppress the slide-out label while the tab's flyout is open — the flyout header already names it. */
.webpic-siderail_btn[aria-expanded="true"]::after { display: none; }
/* Rail flyout (ui/sideRail): a magviz-style panel that opens beside a rail tab, a speech-bubble tail
   pointing back at the button. Glass like the topbar; ui/sideRail writes top/left + --arrow-pos on
   open, and overflow stays visible so the tail can sit outside the left edge. */
.webpic-flyout { position: fixed; z-index: 810; box-sizing: border-box; width: 280px;
  max-height: calc(100vh - 24px); display: flex; flex-direction: column; overflow: visible;
  color: var(--webpic-fg);
  background: color-mix(in srgb, var(--webpic-bg) 80%, transparent);
  border: 1px solid color-mix(in srgb, var(--webpic-border) 70%, transparent);
  border-radius: 10px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  /* Control-sizing vars are scoped to .webpic-shell / .webpic-topbar; redeclare them so the mounted
     pane's checkboxes/slider size correctly outside the shell (otherwise var() falls back to auto). */
  --webpic-input-bg: rgba(0, 0, 0, 0.28); --webpic-radius: 4px; --webpic-unit: 22px; }
.webpic-flyout[hidden] { display: none; }
.webpic-flyout_header { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; height: 30px;
  padding: 0 4px 0 11px; border-radius: 9px 9px 0 0; /* nests inside the 10px/1px border (overflow is visible) */
  background: color-mix(in srgb, var(--webpic-fg) 4%, transparent); /* lifted header, matching the floating window */
  border-bottom: 1px solid color-mix(in srgb, var(--webpic-border) 55%, transparent); }
.webpic-flyout_title { flex: 1; font-size: 10px; line-height: 1; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--webpic-muted); }
.webpic-flyout_close { appearance: none; display: grid; place-items: center; width: 20px; height: 20px;
  padding: 0; border: none; border-radius: 5px; background: transparent; color: var(--webpic-muted);
  cursor: pointer; opacity: 0.6; transition: opacity .12s ease, background .12s ease, color .12s ease; }
.webpic-flyout_close:hover, .webpic-flyout_close:focus-visible { opacity: 1; outline: none;
  color: var(--webpic-fg); background: color-mix(in srgb, var(--webpic-fg) 8%, transparent); }
.webpic-flyout_close svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor;
  stroke-width: 1.6; stroke-linecap: round; }
.webpic-flyout_body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 9px 9px; }
/* The mounted Scene pane keeps its control rows but sheds its own title + folder bar — the flyout
   header names it (mirrors magviz stripping the inner pane chrome). */
.webpic-flyout_body .webpic-pane_title, .webpic-flyout_body .webpic-folder_bar { display: none; }
.webpic-flyout_body .webpic-folder { border-top: none; }
/* Speech-bubble tail on the left edge, pointing back at the rail (--arrow-pos from sideRail): a
   border-layer triangle under a fill-layer triangle 1px inward, so the seam disappears. */
.webpic-flyout_arrow { position: absolute; left: 0; top: var(--arrow-pos, 50%); width: 0; height: 0;
  pointer-events: none; }
.webpic-flyout_arrow::before, .webpic-flyout_arrow::after { content: ""; position: absolute;
  width: 0; height: 0; border-top: 9px solid transparent; border-bottom: 9px solid transparent; }
.webpic-flyout_arrow::before { top: -9px; right: 0;
  border-right: 9px solid color-mix(in srgb, var(--webpic-border) 70%, transparent); }
.webpic-flyout_arrow::after { top: -8px; right: -1px;
  border-right: 8px solid color-mix(in srgb, var(--webpic-bg) 80%, transparent); }
/* Grid-info card: a parent-level floating dialog above the rail (ui/cameraRail). pointer-events: auto
   so its copy button works; z-index over the transient status pill (11), under the help modal (20). */
.webpic-coords-card { position: fixed; left: 50%; bottom: calc(54px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 12; pointer-events: auto; box-sizing: border-box; min-width: 248px; max-width: 92vw;
  padding: 10px 12px; background: var(--webpic-bg); color: var(--webpic-fg);
  border: 1px solid var(--webpic-border); border-radius: 8px;
  font: 500 11px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
.webpic-coords-card[hidden] { display: none; }
.webpic-coords-card_row { display: flex; justify-content: space-between; gap: 18px; padding: 1px 0; }
.webpic-coords-card_label { color: var(--webpic-muted); }
.webpic-coords-card_value { color: var(--webpic-fg); text-align: right; white-space: nowrap; }
/* Separate the static grid facts from the live View + Center pose rows below. */
.webpic-coords-card_rows { margin-bottom: 6px; padding-bottom: 6px;
  border-bottom: 1px solid var(--webpic-border); }
/* Status pill: bottom-center loading/error feedback (ui/statusPill.ts). Geometry mirrors the
   index.html boot splash exactly so the HTML→JS handoff is pixel-stable. The delayed visibility
   transition on fade-out keeps the element readable through the fade, then drops it from the
   a11y tree; fade-in flips visibility instantly. */
.webpic-status { position: fixed; left: 50%; bottom: 24px; z-index: 11; pointer-events: none;
  display: flex; align-items: center; gap: 9px; padding: 8px 15px;
  background: var(--webpic-bg); color: var(--webpic-muted);
  border: 1px solid var(--webpic-border); border-radius: 999px;
  font: 500 13px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  opacity: 0; visibility: hidden; transform: translate(-50%, 6px);
  transition: opacity 160ms ease, transform 160ms ease, visibility 0s linear 160ms; }
.webpic-status.is-visible { opacity: 1; visibility: visible; transform: translate(-50%, 0);
  transition: opacity 160ms ease, transform 160ms ease; }
.webpic-status_spinner { width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%;
  border: 2px solid var(--webpic-border); border-top-color: var(--webpic-accent);
  animation: webpic-spin 0.9s linear infinite; }
.webpic-status_text { white-space: nowrap; }
.webpic-status[data-kind="error"] { color: #e06c75; border-color: rgba(224, 108, 117, 0.4); }
.webpic-status[data-kind="error"] .webpic-status_spinner { animation: none;
  border-color: currentColor; opacity: 0.5; }
@keyframes webpic-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .webpic-status, .webpic-status.is-visible { transition: opacity 160ms ease; transform: translateX(-50%); }
  .webpic-status_spinner { animation-duration: 2s; }
}
/* Keyboard cheat-sheet modal (ui/helpOverlay.ts): full-viewport dimmer + a centered card. z-index in a
   high band (above the floating-window stack, which rises from 15 without bound — see floating/zStack). */
.webpic-help { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center;
  justify-content: center; padding: 24px; box-sizing: border-box; background: rgba(8, 12, 16, 0.55);
  color: var(--webpic-fg); font: 500 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
.webpic-help[hidden] { display: none; }
.webpic-help_panel { width: 100%; max-width: 680px; max-height: 100%; overflow-y: auto;
  padding: 18px 20px; box-sizing: border-box; background: var(--webpic-bg);
  border: 1px solid var(--webpic-border); border-radius: 10px; }
.webpic-help_title { font-size: 13px; margin-bottom: 14px; }
.webpic-help_grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 16px 28px; }
.webpic-help_section-title { color: var(--webpic-accent); margin-bottom: 6px; }
.webpic-help_row { display: flex; justify-content: space-between; gap: 14px; padding: 2px 0; }
.webpic-help_keys { color: var(--webpic-fg); white-space: nowrap; font: inherit; }
.webpic-help_action { color: var(--webpic-muted); text-align: right; }
@media (prefers-reduced-motion: reduce) {
  .webpic-help { background: rgba(8, 12, 16, 0.7); }
}
/* Top menu bar (ui/topBar): brand + dataset/field pickers + time scrub + a hover-revealed action
   cluster. A centered, content-sized translucent glass pill (magviz's topbar): ~25% bg + blur, with
   content dimmed via --topbar-fg at rest and brightening on hover/focus. The SVG marks stroke with
   currentColor, so dimming the 'color' prop dims text + icons together; the accent brand mark is exempt.
   Declares the shell-local control tokens itself since it lives outside .webpic-shell. */
.webpic-topbar { position: fixed; top: calc(8px + env(safe-area-inset-top)); left: 50%;
  transform: translateX(-50%); z-index: 800; box-sizing: border-box;
  display: flex; align-items: center; gap: 6px; padding: 0 10px; height: 46px;
  max-width: calc(100vw - 24px);
  color: color-mix(in srgb, var(--webpic-fg) calc(var(--topbar-fg) * 100%), transparent);
  background: color-mix(in srgb, var(--webpic-bg) 25%, transparent);
  border: 1px solid color-mix(in srgb, var(--webpic-border) 45%, transparent);
  border-radius: 999px;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.22);
  font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  --webpic-input-bg: rgba(0, 0, 0, 0.28); --webpic-radius: 999px; --webpic-unit: 30px;
  --topbar-fg: 0.78;
  transition: opacity 240ms ease, background .18s ease, border-color .18s ease,
    box-shadow .18s ease, color .18s ease; }
.webpic-topbar:hover, .webpic-topbar:focus-within { --topbar-fg: 1;
  background: color-mix(in srgb, var(--webpic-bg) 92%, transparent);
  border-color: color-mix(in srgb, var(--webpic-border) 85%, transparent);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34); }
.webpic-topbar[hidden] { display: none; }
.webpic-topbar_brand { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding-right: 4px;
  font-weight: 700; letter-spacing: 0.04em; }
.webpic-topbar_mark { display: grid; place-items: center; color: var(--webpic-accent); }
.webpic-topbar_mark svg { display: block; width: 18px; height: 18px; fill: none; stroke: currentColor;
  stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.webpic-topbar_btn { box-sizing: border-box; min-width: 0; height: var(--webpic-unit); padding: 0 10px;
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font: inherit;
  background: var(--webpic-input-bg); color: var(--webpic-fg);
  border: 1px solid var(--webpic-border); border-radius: var(--webpic-radius);
  transition: background .15s ease, border-color .15s ease, opacity .15s ease; }
.webpic-topbar_btn:hover, .webpic-topbar_btn:focus-visible { outline: none;
  background: color-mix(in srgb, var(--webpic-fg) 10%, transparent); }
.webpic-topbar_btn[aria-expanded="true"] {
  border-color: color-mix(in srgb, var(--webpic-accent) 55%, transparent);
  background: color-mix(in srgb, var(--webpic-accent) 20%, transparent); }
.webpic-topbar_btn:disabled { opacity: 0.4; cursor: default; }
.webpic-topbar_btn:disabled:hover { background: var(--webpic-input-bg); }
/* Dataset/field pickers recede at rest (their solid fill otherwise competes with the scene); the
   bar's hover/focus brings them back in step with --topbar-fg, as does opening one (aria-expanded). */
.webpic-topbar_dataset, .webpic-topbar_field { opacity: 0.7; }
.webpic-topbar:hover .webpic-topbar_dataset, .webpic-topbar:focus-within .webpic-topbar_dataset,
.webpic-topbar:hover .webpic-topbar_field, .webpic-topbar:focus-within .webpic-topbar_field,
.webpic-topbar_dataset[aria-expanded="true"], .webpic-topbar_field[aria-expanded="true"] {
  opacity: 1; }
.webpic-topbar_icon { width: var(--webpic-unit); padding: 0; justify-content: center; }
.webpic-topbar_btn svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor;
  stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.webpic-topbar_label { flex: 0 1 auto; min-width: 0; max-width: 18ch; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.webpic-topbar_field .webpic-topbar_label { max-width: 14ch; } /* the content button stays a touch tighter */
.webpic-topbar_caret { display: grid; flex: 0 0 auto; place-items: center; color: var(--webpic-muted); }
.webpic-topbar_caret svg { display: block; width: 12px; height: 12px; fill: none; stroke: currentColor;
  stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
/* Time control: a compact "step N ▾" chip that reveals a scrub popover (track + prev/next) on the
   wrapper's hover/focus/pin (see the shared .webpic-topbar_pop reveal below). --webpic-radius scoped
   to 4px so the chip + the popover's track/grip stay crisp against the bar's 999px pills. */
.webpic-topbar_time { position: relative; display: flex; align-items: center; --webpic-radius: 4px; }
.webpic-topbar_time.is-disabled { opacity: 0.5; }
.webpic-topbar_chip { position: relative; box-sizing: border-box; height: var(--webpic-unit);
  padding: 0 8px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font: inherit;
  background: transparent; color: var(--webpic-muted); border: 0; border-radius: var(--webpic-radius);
  white-space: nowrap; font-variant-numeric: tabular-nums;
  transition: background .15s ease, color .15s ease; }
.webpic-topbar_chip:hover, .webpic-topbar_chip:focus-visible { outline: none; color: var(--webpic-fg);
  background: color-mix(in srgb, var(--webpic-fg) 10%, transparent); }
.webpic-topbar_chip[aria-expanded="true"] { color: var(--webpic-fg); }
.webpic-topbar_chip:disabled { cursor: default; }
.webpic-topbar_chip:disabled:hover { background: transparent; color: var(--webpic-muted); }
.webpic-topbar_chip .webpic-topbar_caret svg { transition: transform .18s ease; }
.webpic-topbar_reveal.is-expanded .webpic-topbar_chip .webpic-topbar_caret svg {
  transform: rotate(180deg); }
.webpic-topbar_step { white-space: nowrap; }
/* Compact, borderless step buttons (magviz's subtle scrubber) — live inside the scrub popover. */
.webpic-topbar_step-btn { box-sizing: border-box; width: 26px; height: 26px; padding: 0; border: 0;
  display: grid; place-items: center; background: transparent; color: inherit; opacity: 0.75;
  border-radius: var(--webpic-radius); cursor: pointer;
  transition: opacity .15s ease, background .15s ease; }
.webpic-topbar_step-btn:hover, .webpic-topbar_step-btn:focus-visible { opacity: 1; outline: none;
  background: color-mix(in srgb, var(--webpic-fg) 10%, transparent); }
.webpic-topbar_step-btn:disabled { opacity: 0.3; cursor: default; }
.webpic-topbar_step-btn:disabled:hover { background: transparent; }
.webpic-topbar_step-btn svg { display: block; width: 14px; height: 14px; fill: none;
  stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
/* The custom range control wants width:100% for a panel row; pin it to a fixed track in the popover.
   The inner track keeps its half-grip side margins (load-bearing — grip stays inside at index 0/max). */
.webpic-topbar_track.webpic-range { width: 160px; flex: 0 0 auto; }

/* Shared hover/focus/pin reveal — the time chip and the actions chevron both use it: a glass popover
   under the trigger, hidden until the wrapper is hovered/focused or pinned (.is-expanded), gated off
   while disabled. The trigger's ::after bridges the gap so the cursor can cross to the popover; a
   two-triangle arrow points up at the trigger. */
.webpic-topbar_reveal { position: relative; flex: 0 0 auto; display: flex; align-items: center; }
.webpic-topbar_chevron { position: relative; opacity: 0.7; transition: opacity .18s ease; }
.webpic-topbar:hover .webpic-topbar_chevron,
.webpic-topbar:focus-within .webpic-topbar_chevron { opacity: 1; }
.webpic-topbar_chevron svg { transition: transform .18s ease; }
.webpic-topbar_reveal.is-expanded .webpic-topbar_chevron svg { transform: rotate(180deg); }
.webpic-topbar_chevron::after, .webpic-topbar_chip::after { content: ""; position: absolute;
  top: 100%; left: 0; width: 100%; height: 16px; } /* bridges the wider gap so hover can cross */
.webpic-topbar_pop { position: absolute; top: 100%; margin-top: 15px; z-index: 1;
  background: color-mix(in srgb, var(--webpic-bg) 92%, transparent);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--webpic-border) 85%, transparent);
  border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
  opacity: 0; visibility: hidden; transform: translate(var(--pop-x, 0px), -6px); pointer-events: none;
  transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s; }
.webpic-topbar_reveal:not(.is-disabled):hover > .webpic-topbar_pop,
.webpic-topbar_reveal:not(.is-disabled):focus-within > .webpic-topbar_pop,
.webpic-topbar_reveal.is-expanded > .webpic-topbar_pop { opacity: 1; visibility: visible;
  transform: translate(var(--pop-x, 0px), 0); pointer-events: auto;
  transition: opacity .18s ease, transform .18s ease; }
.webpic-topbar_pop::before, .webpic-topbar_pop::after { content: ""; position: absolute;
  bottom: 100%; border: 8px solid transparent; }
.webpic-topbar_pop::before {
  border-bottom-color: color-mix(in srgb, var(--webpic-border) 85%, transparent); }
.webpic-topbar_pop::after { margin-bottom: -1px;
  border-bottom-color: color-mix(in srgb, var(--webpic-bg) 92%, transparent); }
/* Actions popover: right-anchored 2-col icon grid, arrow near the right. */
.webpic-topbar_actions { right: 0; padding: 6px; }
.webpic-topbar_actions-grid { display: grid; grid-template-columns: repeat(2, var(--webpic-unit));
  gap: 4px; }
.webpic-topbar_actions::before, .webpic-topbar_actions::after { right: 14px; }
/* Time scrub popover: centered under the chip (--pop-x: -50% pairs with left: 50%), single row
   [prev | track | next], arrow centered. */
.webpic-topbar_time-pop { left: 50%; --pop-x: -50%; display: flex; align-items: center; gap: 4px;
  padding: 5px 7px; }
.webpic-topbar_time-pop::before, .webpic-topbar_time-pop::after { left: 50%; margin-left: -8px; }
/* Compact bar (phones / very narrow windows): JS adds .is-compact below ~560px and relocates the time
   scrub into the chevron's action panel. The bar tightens — brand wordmark drops, pickers truncate
   harder — so the chevron never spills past the viewport edge. The relocated scrub de-floats: it sits
   inline + always-open inside the panel, so there's no nested popover to clip at the screen edge. */
.webpic-topbar.is-compact { gap: 4px; padding: 0 8px; }
.webpic-topbar.is-compact .webpic-topbar_word { display: none; }
.webpic-topbar.is-compact .webpic-topbar_dataset .webpic-topbar_label,
.webpic-topbar.is-compact .webpic-topbar_field .webpic-topbar_label { max-width: 9ch; }
.webpic-topbar.is-compact .webpic-topbar_actions { display: flex; flex-direction: column;
  align-items: stretch; gap: 8px; min-width: 224px; padding: 8px; }
.webpic-topbar.is-compact .webpic-topbar_actions-grid {
  grid-template-columns: repeat(4, var(--webpic-unit)); justify-content: center; }
/* The step+slider sit in a subtle full-bleed footer tray (lighter fill, no border) that cleanly
   divides them from the action icons above; the readout de-buttons into a plain field. */
.webpic-topbar.is-compact .webpic-topbar_actions .webpic-topbar_time { flex-direction: column;
  align-items: stretch; gap: 6px; margin: 0 -8px -8px; padding: 8px; border-radius: 0 0 11px 11px;
  background: color-mix(in srgb, var(--webpic-fg) 6%, transparent); }
.webpic-topbar.is-compact .webpic-topbar_actions .webpic-topbar_chip { width: 100%; height: auto;
  padding: 0; justify-content: center; cursor: default; pointer-events: none;
  color: var(--webpic-muted); }
.webpic-topbar.is-compact .webpic-topbar_actions .webpic-topbar_chip::after,
.webpic-topbar.is-compact .webpic-topbar_actions .webpic-topbar_chip .webpic-topbar_caret {
  display: none; }
.webpic-topbar.is-compact .webpic-topbar_actions .webpic-topbar_time .webpic-topbar_time-pop {
  position: static; transform: none; opacity: 1; visibility: visible; pointer-events: auto;
  margin: 0; padding: 0; border: 0; background: transparent; box-shadow: none;
  -webkit-backdrop-filter: none; backdrop-filter: none; transition: none; }
.webpic-topbar.is-compact .webpic-topbar_time-pop::before,
.webpic-topbar.is-compact .webpic-topbar_time-pop::after { display: none; }
.webpic-topbar.is-compact .webpic-topbar_track.webpic-range { flex: 1 1 auto; width: auto; }
/* Anchored single-select popover (ui/controls/popover) — the dataset + content pickers share it.
   Body-appended (escapes the bar's clip); z-index above the help modal (1000) so a transient menu is
   never occluded — even over a raised floating panel. Declares the control tokens locally. */
.webpic-popover { position: fixed; z-index: 1100; box-sizing: border-box; min-width: 200px;
  max-height: min(60vh, 420px); overflow-y: auto; padding: 4px;
  background: var(--webpic-bg); color: var(--webpic-fg);
  border: 1px solid var(--webpic-border); border-radius: 8px;
  font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  --webpic-radius: 4px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36); }
.webpic-popover[hidden] { display: none; }
.webpic-popover_item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px;
  border-radius: var(--webpic-radius); cursor: pointer; }
.webpic-popover_item.is-active, .webpic-popover_item:hover {
  background: color-mix(in srgb, var(--webpic-fg) 10%, transparent); }
.webpic-popover_item[aria-selected="true"] {
  background: color-mix(in srgb, var(--webpic-accent) 18%, transparent); }
.webpic-popover_check { flex: 0 0 14px; display: grid; place-items: center; height: 16px; opacity: 0; }
.webpic-popover_item[aria-selected="true"] .webpic-popover_check { opacity: 1; }
.webpic-popover_check svg { display: block; width: 12px; height: 12px; fill: none;
  stroke: var(--webpic-accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.webpic-popover_field { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.webpic-popover_text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.webpic-popover_meta { color: var(--webpic-muted); font-size: 11px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
/* Colormap picker rows: a fixed-width gradient swatch (so every row's gradient is identical
   regardless of label length) + the name filling the rest, right-aligned beside the check cell. */
.webpic-popover.is-swatches { min-width: 216px; }
.webpic-popover_swatch { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; }
.webpic-popover_swatch .webpic-swatch_canvas { flex: 0 0 100px; height: 14px; }
.webpic-popover_swatch .webpic-swatch_name { flex: 1 1 auto; min-width: 0; text-align: right;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--webpic-fg); }
/* Floating colorbar (ui/colorbar): a draggable, collapsible gradient strip for the selected layer's
   color mapping. Glass like the rails; transform: translate(--drag-x/y) is written by ui/floating's
   drag, then snapped to inline left/right/top/bottom anchors with data-edge driving orientation
   (left/right → vertical, top/bottom → horizontal). Declares the shell-local control tokens itself
   (it lives outside .webpic-shell). z over the coords card (12), under the help modal (20). */
.webpic-cbar { position: fixed; z-index: 13; box-sizing: border-box; display: flex;
  align-items: center; gap: 8px; padding: 7px 9px; cursor: grab; touch-action: none;
  color: var(--webpic-fg);
  background: color-mix(in srgb, var(--webpic-bg) 25%, transparent);
  border: 1px solid color-mix(in srgb, var(--webpic-border) 45%, transparent);
  border-radius: 12px; box-shadow: 0 6px 22px rgba(0, 0, 0, 0.22);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  font: 500 11px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  transform: translate(var(--drag-x, 0px), var(--drag-y, 0px));
  transition: opacity 240ms ease, background .18s ease, border-color .18s ease, box-shadow .18s ease,
    left .3s cubic-bezier(0.25, 1, 0.5, 1), right .3s cubic-bezier(0.25, 1, 0.5, 1),
    top .3s cubic-bezier(0.25, 1, 0.5, 1), bottom .3s cubic-bezier(0.25, 1, 0.5, 1),
    transform .3s cubic-bezier(0.25, 1, 0.5, 1);
  --webpic-input-bg: rgba(0, 0, 0, 0.28); --webpic-radius: 4px; --webpic-unit: 22px; }
.webpic-cbar[hidden] { display: none; }
.webpic-cbar:hover, .webpic-cbar:focus-within {
  background: color-mix(in srgb, var(--webpic-bg) 92%, transparent);
  border-color: color-mix(in srgb, var(--webpic-border) 85%, transparent);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34); }
/* No transform transition during a drag (latency); restore the grab affordance on release. */
.webpic-cbar.is-dragging { transition: none; cursor: grabbing; }
/* Resize pivot for collapse/expand: translate the FREE axis by -50% so the strip grows/shrinks
   symmetrically around its center (dragSnap anchors that axis by its center px), while the docked
   axis stays pinned by its edge anchor. A free drop in the middle (data-docked=false) centers both. */
.webpic-cbar[data-edge="top"]:not([data-docked="false"]),
.webpic-cbar[data-edge="bottom"]:not([data-docked="false"]) {
  transform: translateX(-50%) translate(var(--drag-x, 0px), var(--drag-y, 0px)); }
.webpic-cbar[data-edge="left"]:not([data-docked="false"]),
.webpic-cbar[data-edge="right"]:not([data-docked="false"]) {
  transform: translateY(-50%) translate(var(--drag-x, 0px), var(--drag-y, 0px)); }
.webpic-cbar[data-docked="false"] {
  transform: translate(-50%, -50%) translate(var(--drag-x, 0px), var(--drag-y, 0px)); }
/* Vertical when docked to a side edge; horizontal (the default row) on top/bottom. */
.webpic-cbar[data-edge="left"], .webpic-cbar[data-edge="right"] { flex-direction: column; }
/* Collapsed: recede at rest, brighten on hover; a thinner, flatter frame that reads like a bottom
   rail button rather than a chunky glass pill (magviz). */
.webpic-cbar.collapsed { opacity: 0.62; border-radius: 6px; padding: 3px;
  border-color: color-mix(in srgb, var(--webpic-border) 20%, transparent);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.16); }
.webpic-cbar.collapsed:hover, .webpic-cbar.collapsed:focus-within { opacity: 1; }
.webpic-cbar.collapsed .webpic-cbar_ticks, .webpic-cbar.collapsed .webpic-cbar_caption {
  display: none; }
/* gap:0 so the tick rail sits flush under the strip (marks touch the bar); the caption keeps its own
   breathing room via its margin (margin-bottom on top/bottom, margin-left on the rotated side dock). */
.webpic-cbar_main { display: flex; flex: 1 1 auto; gap: 0; min-width: 0; min-height: 0; }
.webpic-cbar[data-edge="top"] .webpic-cbar_main, .webpic-cbar[data-edge="bottom"] .webpic-cbar_main {
  flex-direction: column; align-items: stretch; }
.webpic-cbar[data-edge="left"] .webpic-cbar_main, .webpic-cbar[data-edge="right"] .webpic-cbar_main {
  flex-direction: row; align-items: stretch; }
.webpic-cbar_strip { position: relative; flex: 0 0 auto; border-radius: 4px; overflow: hidden;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--webpic-border) 60%, transparent);
  transition: width .28s cubic-bezier(0.25, 1, 0.5, 1), height .28s cubic-bezier(0.25, 1, 0.5, 1); }
.webpic-cbar[data-edge="top"] .webpic-cbar_strip, .webpic-cbar[data-edge="bottom"] .webpic-cbar_strip {
  width: 320px; height: 20px; }
.webpic-cbar[data-edge="left"] .webpic-cbar_strip, .webpic-cbar[data-edge="right"] .webpic-cbar_strip {
  width: 20px; height: 200px; }
/* Collapsed: a chunkier, shorter gradient that fills the rail-height row (magviz 110×24). */
.webpic-cbar.collapsed[data-edge="top"] .webpic-cbar_strip,
.webpic-cbar.collapsed[data-edge="bottom"] .webpic-cbar_strip { width: 110px; height: 24px; }
.webpic-cbar.collapsed[data-edge="left"] .webpic-cbar_strip,
.webpic-cbar.collapsed[data-edge="right"] .webpic-cbar_strip { width: 24px; height: 110px; }
.webpic-cbar_canvas { display: block; width: 100%; height: 100%; }
/* Collapsed-only field key, painted faintly over the gradient (magviz mini-label); empty → hidden,
   brightens on hover, rotates with the strip on the side edges. */
.webpic-cbar_minilabel { display: none; }
.webpic-cbar.collapsed .webpic-cbar_minilabel:not(:empty) {
  display: flex; align-items: center; justify-content: center;
  position: absolute; inset: 0; z-index: 2; pointer-events: none; user-select: none;
  color: var(--webpic-fg); opacity: 0.45;
  font: 500 13px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.2px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45); transition: opacity .2s ease, text-shadow .2s ease; }
.webpic-cbar.collapsed:hover .webpic-cbar_minilabel {
  opacity: 1; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75); }
.webpic-cbar.collapsed[data-edge="left"] .webpic-cbar_minilabel,
.webpic-cbar.collapsed[data-edge="right"] .webpic-cbar_minilabel {
  writing-mode: vertical-rl; transform: rotate(180deg); }
/* Tick rail: a thin gutter flush against the gradient (no gap), spanning the strip's long axis so a
   tick's --t (0 = min, 1 = max) lands on the painted extent. Every tick is a centered label with a
   flush mark (::before); overflow stays visible so an edge label can half-overhang the rail. */
.webpic-cbar_ticks { position: relative; flex: 0 0 auto; overflow: visible;
  color: var(--webpic-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.webpic-cbar[data-edge="top"] .webpic-cbar_ticks, .webpic-cbar[data-edge="bottom"] .webpic-cbar_ticks {
  height: 18px; }
.webpic-cbar[data-edge="left"] .webpic-cbar_ticks, .webpic-cbar[data-edge="right"] .webpic-cbar_ticks {
  width: 40px; }
.webpic-cbar_tick { position: absolute; white-space: nowrap; }
.webpic-cbar_tick::before { content: ""; position: absolute;
  background: color-mix(in srgb, var(--webpic-muted) 80%, transparent); }
/* Horizontal: marks hang down from the bar's bottom edge (top:-1px sits over the strip's 1px inner
   border → flush, no gap), the label centered just below. */
.webpic-cbar[data-edge="top"] .webpic-cbar_tick, .webpic-cbar[data-edge="bottom"] .webpic-cbar_tick {
  top: 0; left: calc(var(--t) * 100%); transform: translateX(-50%); padding-top: 8px; }
.webpic-cbar[data-edge="top"] .webpic-cbar_tick::before,
.webpic-cbar[data-edge="bottom"] .webpic-cbar_tick::before {
  left: 50%; top: -1px; width: 1px; height: 6px; transform: translateX(-50%); }
/* Vertical: marks point right from the bar's right edge (left:-1px → flush), the label to their
   right; top = (1 − t) so the maximum reads at the top. */
.webpic-cbar[data-edge="left"] .webpic-cbar_tick, .webpic-cbar[data-edge="right"] .webpic-cbar_tick {
  left: 0; top: calc((1 - var(--t)) * 100%); transform: translateY(-50%); padding-left: 9px; }
.webpic-cbar[data-edge="left"] .webpic-cbar_tick::before,
.webpic-cbar[data-edge="right"] .webpic-cbar_tick::before {
  top: 50%; left: -1px; width: 6px; height: 1px; transform: translateY(-50%); }
/* Field key, sized into the gradient stack: above it (column) on top/bottom, right of it (row,
   rotated) on the side edges. Collapsed hides it for the over-gradient mini-label. */
.webpic-cbar_caption { flex: 0 0 auto; align-self: center; text-align: center; color: var(--webpic-fg);
  font-size: 12px; font-weight: 700; letter-spacing: 0.04em; line-height: 1.2;
  max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A touch more air between the title and the gradient + its tick labels. */
.webpic-cbar[data-edge="top"] .webpic-cbar_caption, .webpic-cbar[data-edge="bottom"] .webpic-cbar_caption {
  margin-bottom: 4px; }
/* Vertical docks: the field key reads up the right side of the gradient (order:2 trails the strip +
   ticks), mirroring magviz's side colorbar — not the left. Rotate 180° so it reads bottom-to-top
   (matching the collapsed mini-label), with a wider gap from the tick labels. */
.webpic-cbar[data-edge="left"] .webpic-cbar_caption, .webpic-cbar[data-edge="right"] .webpic-cbar_caption {
  writing-mode: vertical-rl; text-orientation: mixed; max-width: none; max-height: 14ch; order: 2;
  transform: rotate(180deg); margin-left: 6px; }
/* Expanded panels widen their long-axis margins (symmetric) so the end tick labels get breathing room
   and the hover gear sits in the margin beside the strip; collapsed keeps its compact 3px pill. */
.webpic-cbar:not(.collapsed)[data-edge="top"], .webpic-cbar:not(.collapsed)[data-edge="bottom"] {
  padding: 7px 26px; }
.webpic-cbar:not(.collapsed)[data-edge="left"], .webpic-cbar:not(.collapsed)[data-edge="right"] {
  padding: 26px 7px; }
/* Expanded: the gear sits in the long-axis margin aligned to the strip — right of it (horizontal) or
   below it (vertical), like the collapsed pill — but hidden until the bar is hovered or its popover is
   open, so an expanded colorbar reads clean for screenshots. Absolute (out of the strip's flow) so the
   gradient keeps symmetric margins inside the wider padding. */
.webpic-cbar_actions { position: absolute; display: flex; gap: 2px;
  opacity: 0; pointer-events: none; transition: opacity .15s ease; }
.webpic-cbar[data-edge="top"] .webpic-cbar_actions, .webpic-cbar[data-edge="bottom"] .webpic-cbar_actions {
  top: 50%; right: 3px; transform: translateY(-50%); } /* strip is vertically centred in the panel */
.webpic-cbar[data-edge="left"] .webpic-cbar_actions, .webpic-cbar[data-edge="right"] .webpic-cbar_actions {
  bottom: 4px; left: 17px; transform: translateX(-50%); } /* 17px = 7px pad + 10px half-strip */
.webpic-cbar:hover .webpic-cbar_actions, .webpic-cbar:focus-within .webpic-cbar_actions,
.webpic-cbar:has(.webpic-cbar_settings[aria-expanded="true"]) .webpic-cbar_actions {
  opacity: 1; pointer-events: auto; }
/* Collapsed: the gear returns to the flow beside the mini gradient and stays visible — a docked pill
   keeps its settings affordance; only the expanded panel hides it until hover. */
.webpic-cbar.collapsed .webpic-cbar_actions {
  position: static; opacity: 1; pointer-events: auto; transform: none; }
.webpic-cbar_btn { box-sizing: border-box; width: 22px; height: 22px; padding: 0; display: grid;
  place-items: center; cursor: pointer; opacity: 0.6; background: transparent; color: var(--webpic-muted);
  border: none; border-radius: 5px; transition: opacity .12s ease, background .12s ease, color .12s ease; }
.webpic-cbar_btn:hover, .webpic-cbar_btn:focus-visible { opacity: 1; outline: none; color: var(--webpic-fg);
  background: color-mix(in srgb, var(--webpic-fg) 8%, transparent); }
.webpic-cbar_settings[aria-expanded="true"] { opacity: 1; color: var(--webpic-fg);
  background: color-mix(in srgb, var(--webpic-accent) 28%, transparent); }
.webpic-cbar_btn svg { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor;
  stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
/* Colorbar settings popover (ui/colorbar/colorbarSettings): a small glass dialog hosting the colormap
   controls, body-appended so it escapes the bar's clip; positioned beside the gear toward the
   viewport center. Headerless (Esc + outside-click dismiss) — too small for a title bar; each control
   stacks full-width with its own uppercase mini-label above it. */
.webpic-cbar-pop { position: fixed; z-index: 14; box-sizing: border-box; width: 240px;
  max-height: calc(100vh - 16px); display: flex; flex-direction: column; overflow: hidden;
  color: var(--webpic-fg);
  background: color-mix(in srgb, var(--webpic-bg) 92%, transparent);
  border: 1px solid color-mix(in srgb, var(--webpic-border) 85%, transparent);
  border-radius: 10px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  --webpic-input-bg: rgba(0, 0, 0, 0.28); --webpic-radius: 4px; --webpic-unit: 22px; }
.webpic-cbar-pop[hidden] { display: none; }
.webpic-cbar-pop_body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 11px 11px 12px; }
.webpic-cbar-pop_body .webpic-pane_title, .webpic-cbar-pop_body .webpic-folder_bar { display: none; }
.webpic-cbar-pop_body .webpic-folder { border-top: none; }
.webpic-cbar-pop_body .webpic-folder_body { gap: 12px; padding: 0; }
/* Stack each control full-width with its label as an uppercase caption above (not a 132px side cell). */
.webpic-cbar-pop_body .webpic-row { flex-wrap: wrap; padding: 0 1px; }
.webpic-cbar-pop_body .webpic-row_label { flex: 1 1 100%; padding: 0 1px 5px; color: var(--webpic-muted);
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; }
.webpic-cbar-pop_body .webpic-row_value { flex: 1 1 100%; }
/* Window: box-less min/max readouts flanking the dual slider (min hugs left, max hugs right). */
.webpic-cbar-pop_body .webpic-range_text { justify-content: space-between; align-items: center; gap: 8px;
  margin-top: 2px; }
.webpic-cbar-pop_body .webpic-range_text::before { content: "min"; color: var(--webpic-muted); }
.webpic-cbar-pop_body .webpic-range_text::after { content: "max"; color: var(--webpic-muted); }
.webpic-cbar-pop_body .webpic-range_input { flex: 1 1 0; min-width: 0; height: auto; padding: 0 2px;
  border: none; background: transparent; }
.webpic-cbar-pop_body .webpic-range_input:first-of-type { text-align: left; }
.webpic-cbar-pop_body .webpic-range_input:last-of-type { text-align: right; }
/* Floating window (ui/floating/floatingWindow): a reusable draggable + resizable glass panel that
   features mount content into. Grip dots in the header free-drag it (clamp to viewport, no docking);
   the SE-corner grip resizes it; pointerdown raises it. Declares the shell-local control tokens
   itself (it lives outside .webpic-shell). z over the colorbar (13)/its popover (14), under the help
   modal (20) and global control popovers (30). */
.webpic-window { position: fixed; z-index: 15; box-sizing: border-box; display: flex;
  flex-direction: column; overflow: hidden; color: var(--webpic-fg);
  background: color-mix(in srgb, var(--webpic-bg) 80%, transparent);
  border: 1px solid color-mix(in srgb, var(--webpic-border) 60%, transparent);
  border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
  transform: translate(var(--drag-x, 0px), var(--drag-y, 0px));
  transition: opacity 240ms ease, background .18s ease, border-color .18s ease, box-shadow .18s ease;
  --webpic-input-bg: rgba(0, 0, 0, 0.28); --webpic-radius: 4px; --webpic-unit: 22px; }
.webpic-window[hidden] { display: none; }
.webpic-window:hover, .webpic-window:focus-within {
  border-color: color-mix(in srgb, var(--webpic-border) 85%, transparent);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4); }
/* Immediate tracking during a gesture — no position/size lag. */
.webpic-window.is-dragging, .webpic-window.is-resizing { transition: none; }
.webpic-window_bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; height: 28px;
  padding: 0 8px 0 10px; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
  border-bottom: 1px solid color-mix(in srgb, var(--webpic-border) 45%, transparent);
  background: color-mix(in srgb, var(--webpic-fg) 4%, transparent); }
.webpic-window.is-dragging .webpic-window_bar { cursor: grabbing; }
/* Grip dots (magviz): a 2×3 radial-gradient grid; brighten on header hover. Visual only. */
.webpic-window_grip { flex: 0 0 auto; width: 8px; height: 14px; opacity: 0.3; pointer-events: none;
  background-image: radial-gradient(circle, var(--webpic-muted) 1.1px, transparent 1.6px);
  background-size: 4px 5px; transition: opacity .2s ease; }
.webpic-window_bar:hover .webpic-window_grip { opacity: 0.55; }
.webpic-window_title { flex: 1 1 auto; min-width: 0; font-size: 10px; line-height: 1;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--webpic-muted); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.webpic-window_actions { flex: 0 0 auto; display: flex; gap: 2px; }
.webpic-window_close { appearance: none; display: grid; place-items: center; width: 20px; height: 20px;
  padding: 0; border: none; border-radius: 5px; background: transparent; color: var(--webpic-muted);
  cursor: pointer; opacity: 0.6; transition: opacity .12s ease, background .12s ease, color .12s ease; }
.webpic-window_close:hover, .webpic-window_close:focus-visible { opacity: 1; outline: none;
  color: var(--webpic-fg); background: color-mix(in srgb, var(--webpic-fg) 8%, transparent); }
.webpic-window_close svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor;
  stroke-width: 1.6; stroke-linecap: round; }
.webpic-window_body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 10px 10px; }
/* Corner resize grip (magviz): a 3-dot triangle in the SE corner; brighten on hover/resize. */
.webpic-window_resize { position: absolute; right: 0; bottom: 0; width: 22px; height: 22px;
  cursor: nwse-resize; touch-action: none; opacity: 0.35; transition: opacity .2s ease;
  border-bottom-right-radius: 12px;
  background-image:
    radial-gradient(circle, var(--webpic-muted) 1.1px, transparent 1.6px),
    radial-gradient(circle, var(--webpic-muted) 1.1px, transparent 1.6px),
    radial-gradient(circle, var(--webpic-muted) 1.1px, transparent 1.6px);
  background-repeat: no-repeat;
  background-position: right 5px bottom 10px, right 10px bottom 5px, right 5px bottom 5px;
  background-size: 4px 4px; }
.webpic-window:hover .webpic-window_resize { opacity: 0.55; }
.webpic-window_resize:hover, .webpic-window.is-resizing .webpic-window_resize { opacity: 0.85; }
/* Coarse pointers (touch): grow the chrome hit targets a notch — desktop layout is untouched. The
   gnomon tips keep their small visual disc but gain a finger-sized invisible hit area, the same
   ::before-inset trick the range grip uses. Matches viewportTracking's (pointer: coarse) probe. */
@media (pointer: coarse) {
  .webpic-rail { gap: 8px; }
  .webpic-rail_btn { width: 38px; height: 38px; border-radius: 8px; }
  .webpic-rail_btn svg { width: 18px; height: 18px; }
  .webpic-rail_coords { font-size: 12px; line-height: 38px; padding: 0 12px; }
  .webpic-siderail_btn { width: 40px; height: 40px; }
  .webpic-siderail_btn svg { width: 20px; height: 20px; }
  .webpic-cbar_btn { width: 30px; height: 30px; }
  .webpic-cbar_btn svg { width: 16px; height: 16px; }
  .webpic-gnomon_tip::before { content: ""; position: absolute; inset: -10px; border-radius: 50%; }
  .webpic-topbar { --webpic-unit: 34px; }
  .webpic-topbar_step-btn { width: 30px; height: 30px; }
  .webpic-topbar_step-btn svg { width: 16px; height: 16px; }
  .webpic-shell { --webpic-unit: 26px; }
  .webpic-window_bar { height: 34px; }
  .webpic-window_close { width: 28px; height: 28px; }
  .webpic-window_resize { width: 30px; height: 30px; }
}
/* No-hover devices can't trigger the bar's dim→bright, so pin it bright + more opaque for legibility.
   Distinct from (pointer: coarse): a touchscreen laptop is hover:none but pointer:fine. */
@media (hover: none) {
  .webpic-topbar { --topbar-fg: 1; background: color-mix(in srgb, var(--webpic-bg) 92%, transparent); }
  .webpic-topbar_dataset, .webpic-topbar_field { opacity: 1; } /* no hover to bring them back */
}
`;
