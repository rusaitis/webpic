import type { LayerKind } from "@store";

// Layer-specific inline-SVG glyphs shared by the rail (add-buttons) and the Layers panel (row kind
// icon + eye/gear/reorder affordances) — the two M4.7 surfaces. 16×16, aria-hidden; fill defaults to
// none and stroke to currentColor via each host's CSS, so a mark tints to wherever it mounts (filled
// dots opt back in locally). Kept out of ui/icons.ts, which is scoped to cross-cutting affordances.

// One mark per renderable primitive — the verb-as-add rail buttons and the panel rows share these.
export const LAYER_KIND_ICON: Record<LayerKind, string> = {
  // An isometric cube — the volume.
  volume: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l5 2.6v6.4L8 13.8l-5-2.6V4.8z"/><path d="M3 4.8l5 2.6 5-2.6M8 7.4v6.4"/></svg>`,
  // A tilted parallelogram — a single cutting plane.
  slice: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 10.5l5-5h6l-5 5z"/></svg>`,
  // Two flowing curves — traced streamlines.
  fieldlines: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 11c3-1 3-7 6-7s3 6 6 5"/><path d="M2 8c3-1 3-5 6-5"/></svg>`,
  // Scattered filled dots — a particle cloud.
  particles: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="11.2" cy="4" r="1.3" fill="currentColor" stroke="none"/><circle cx="6" cy="11" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="10.2" r="1.3" fill="currentColor" stroke="none"/></svg>`,
};

// Visibility toggle: open eye vs. struck-through eye.
export const ICON_EYE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/></svg>`;
export const ICON_EYE_OFF = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.3 3.8C6.8 3.6 7.4 3.5 8 3.5c4 0 6.5 4.5 6.5 4.5s-.9 1.6-2.5 2.9M9.6 9.7A1.9 1.9 0 016.4 8.1M3.6 5.3C2.2 6.4 1.5 8 1.5 8S4 12.5 8 12.5c.7 0 1.3-.1 1.9-.3"/><path d="M2.5 2.5l11 11"/></svg>`;

// A cog — the per-layer settings entry (selects the layer in M4.7; opens its settings panel in M4.8).
export const ICON_GEAR = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/><path d="M8 1.7l.9 1.6 1.8-.4.2 1.8 1.7.7-.8 1.6.8 1.6-1.7.7-.2 1.8-1.8-.4L8 14.3l-.9-1.6-1.8.4-.2-1.8-1.7-.7.8-1.6-.8-1.6 1.7-.7.2-1.8 1.8.4z"/></svg>`;

// The add affordance on each rail primitive button.
export const ICON_PLUS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`;

// Reorder chevrons — move a layer row up/down the draw order.
export const ICON_CARET_UP = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>`;
export const ICON_CARET_DOWN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`;
