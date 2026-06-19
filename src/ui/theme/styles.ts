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
.webpic-booting .webpic-siderail, .webpic-booting .webpic-topbar {
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
  transition: opacity 240ms ease; }
.webpic-rail[hidden] { display: none; }
.webpic-rail.has-gnomon { padding: 0 80px; }
.webpic-rail_btn { box-sizing: border-box; width: 30px; height: 30px; padding: 0;
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
.webpic-rail_coords { display: block; width: auto; min-width: 30px; max-width: 40vw; padding: 0 9px;
  font: 500 11px/28px ui-monospace, "SF Mono", Menlo, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.webpic-rail_coords[aria-expanded="true"] { opacity: 1;
  border-color: color-mix(in srgb, var(--webpic-accent) 55%, transparent);
  background: color-mix(in srgb, var(--webpic-accent) 20%, transparent); }
/* Left tool rail (ui/sideRail): a magviz-style glass card of flush, borderless icon tabs on the left
   edge, vertically centered — the instance-first rail's first occupants (View/Scene, Probe), kept
   distinct from the data layers. Shares the topbar's glass treatment (blur + bg lift on hover) so the
   chrome reads as one family; each tab's slide-out label is its aria-label (the ::after pill). */
.webpic-siderail { position: fixed; left: calc(8px + env(safe-area-inset-left)); top: 50%;
  transform: translateY(-50%); z-index: 10; box-sizing: border-box;
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
.webpic-flyout { position: fixed; z-index: 11; box-sizing: border-box; width: 280px;
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
  padding: 0 4px 0 11px;
  border-bottom: 1px solid color-mix(in srgb, var(--webpic-border) 55%, transparent); }
.webpic-flyout_title { flex: 1; font-size: 10px; line-height: 1; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--webpic-muted); }
.webpic-flyout_close { appearance: none; display: grid; place-items: center; width: 20px; height: 20px;
  padding: 0; border: none; border-radius: 5px; background: transparent; color: var(--webpic-muted);
  cursor: pointer; opacity: 0.6; transition: opacity .12s ease, background .12s ease, color .12s ease; }
.webpic-flyout_close:hover, .webpic-flyout_close:focus-visible { opacity: 1; outline: none;
  color: var(--webpic-fg); background: color-mix(in srgb, var(--webpic-fg) 8%, transparent); }
.webpic-flyout_close svg { display: block; width: 11px; height: 11px; fill: none; stroke: currentColor;
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
/* Keyboard cheat-sheet modal (ui/helpOverlay.ts): full-viewport dimmer + a centered card. */
.webpic-help { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center;
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
  transform: translateX(-50%); z-index: 10; box-sizing: border-box;
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
.webpic-topbar_brand { display: flex; align-items: center; gap: 8px; padding-right: 4px;
  font-weight: 700; letter-spacing: 0.04em; }
.webpic-topbar_mark { display: grid; place-items: center; color: var(--webpic-accent); }
.webpic-topbar_mark svg { display: block; width: 18px; height: 18px; fill: none; stroke: currentColor;
  stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.webpic-topbar_btn { box-sizing: border-box; height: var(--webpic-unit); padding: 0 10px;
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
.webpic-topbar_label { max-width: 18ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.webpic-topbar_caret { display: grid; place-items: center; color: var(--webpic-muted); }
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
.webpic-topbar_reveal { position: relative; display: flex; align-items: center; }
.webpic-topbar_chevron { position: relative; opacity: 0.7; transition: opacity .18s ease; }
.webpic-topbar:hover .webpic-topbar_chevron,
.webpic-topbar:focus-within .webpic-topbar_chevron { opacity: 1; }
.webpic-topbar_chevron svg { transition: transform .18s ease; }
.webpic-topbar_reveal.is-expanded .webpic-topbar_chevron svg { transform: rotate(180deg); }
.webpic-topbar_chevron::after, .webpic-topbar_chip::after { content: ""; position: absolute;
  top: 100%; left: 0; width: 100%; height: 12px; }
.webpic-topbar_pop { position: absolute; top: 100%; margin-top: 9px; z-index: 1;
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
  bottom: 100%; border: 6px solid transparent; }
.webpic-topbar_pop::before {
  border-bottom-color: color-mix(in srgb, var(--webpic-border) 85%, transparent); }
.webpic-topbar_pop::after { margin-bottom: -1px;
  border-bottom-color: color-mix(in srgb, var(--webpic-bg) 92%, transparent); }
/* Actions popover: right-anchored 2-col icon grid, arrow near the right. */
.webpic-topbar_actions { right: 0; display: grid; grid-template-columns: repeat(2, var(--webpic-unit));
  gap: 4px; padding: 6px; }
.webpic-topbar_actions::before, .webpic-topbar_actions::after { right: 14px; }
/* Time scrub popover: centered under the chip (--pop-x: -50% pairs with left: 50%), single row
   [prev | track | next], arrow centered. */
.webpic-topbar_time-pop { left: 50%; --pop-x: -50%; display: flex; align-items: center; gap: 4px;
  padding: 5px 7px; }
.webpic-topbar_time-pop::before, .webpic-topbar_time-pop::after { left: 50%; margin-left: -6px; }
/* Anchored single-select popover (ui/controls/popover) — the dataset + content pickers share it.
   Body-appended (escapes the bar's clip); z-index above the help modal so a transient menu is never
   occluded. Declares the control tokens locally (not a .webpic-shell descendant). */
.webpic-popover { position: fixed; z-index: 30; box-sizing: border-box; min-width: 200px;
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
  .webpic-gnomon_tip::before { content: ""; position: absolute; inset: -10px; border-radius: 50%; }
  .webpic-topbar { --webpic-unit: 34px; }
  .webpic-topbar_step-btn { width: 30px; height: 30px; }
  .webpic-topbar_step-btn svg { width: 16px; height: 16px; }
  .webpic-shell { --webpic-unit: 26px; }
}
/* No-hover devices can't trigger the bar's dim→bright, so pin it bright + more opaque for legibility.
   Distinct from (pointer: coarse): a touchscreen laptop is hover:none but pointer:fine. */
@media (hover: none) {
  .webpic-topbar { --topbar-fg: 1; background: color-mix(in srgb, var(--webpic-bg) 92%, transparent); }
  .webpic-topbar_dataset, .webpic-topbar_field { opacity: 1; } /* no hover to bring them back */
}
`;
