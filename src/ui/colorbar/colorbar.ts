import { type ColormapBinding, type ColormapId, DEFAULT_COLORMAP } from "@schema/colormap.ts";
import { FIELD_REGISTRY } from "@schema/registry.ts";
import {
  type SimulationStore,
  selectActiveBinding,
  selectVisibleBindings,
  type UiStore,
} from "@store";
import { shallow } from "zustand/vanilla/shallow";
import { createBottomBand } from "../bottomBand/band.ts";
import { bindChromeVisibility } from "../chromeVisibility.ts";
import { isInteractiveTarget, makeEl, makeIconButton } from "../controls/dom.ts";
import type { Disposer } from "../controls/index.ts";
import { installDragSnap, readEdge } from "../floating/dragSnap.ts";
import { installRaise } from "../floating/zStack.ts";
import { createSubscriptions } from "../subscriptions.ts";
import { paintGradient, tickLabels } from "./colorbarGradient.ts";
import { installColorbarSettings } from "./colorbarSettings.ts";
import { colorbarStack } from "./colorbarStack.ts";

// The floating colorbar: a draggable, collapsible stack of gradient strips — one per distinct
// ColormapBinding among the *visible* layers, at most two (DESIGN §UI "max two for sanity"); more
// distinct bindings shows a soft-warn "+N" badge naming the fields without a strip. It snaps to a
// viewport edge and springs clear of the chrome. The gear opens a popover of colormap/scale/window
// controls for the *selected* layer's binding. ui → store only. On the bottom row it is a client of
// ui/bottomBand/band/band: this module owns the strips, the band owns the row.

// Static chrome the colorbar must not cover on drop; zero-area (hidden) matches are skipped. The
// bottom rail's tight per-button rects (not its full-width .webpic-rail container, which can't be
// cleared by a sideways nudge) so the strip slides past the centered cluster.
const CHROME_SELECTOR =
  ".webpic-rail_btn, .webpic-coords-card, .webpic-topbar, .webpic-siderail, .webpic-layers, .webpic-shell, .webpic-chrome, .webpic-status";
const INITIAL_GAP_PX = 12; // first-paint inset (bottom-right); reflow then clears the chrome
// One nice-number target for BOTH orientations, so the tick values are identical horizontal and
// vertical (the set depends only on the window + this count — never the strip's pixel length). 5
// reads well on the 320px-wide horizontal strip without crowding and leaves the 200px vertical one
// with room to spare (stacked labels are short).
const TICK_TARGET = 5;

// Expanded caption: the field key plus its SI unit in brackets when the field has one ("|B| [T]").
// The collapsed mini-label stays bare (just the key) — units only read in the expanded view.
const captionText = (field: string | undefined): string => {
  if (field === undefined || field.length === 0) return "—";
  const unit = FIELD_REGISTRY[field]?.siUnit;
  return unit !== undefined && unit.length > 0 ? `${field} [${unit}]` : field;
};

const ICON = {
  // Sliders — "adjust the colormap": two tracks with knobs.
  settings: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h6M11 5h3M2 11h3M8 11h6"/><circle cx="9.5" cy="5" r="1.6"/><circle cx="6.5" cy="11" r="1.6"/></svg>`,
} as const;

export function installColorbar(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;

  const container = makeEl(doc, "div", "webpic-cbar");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Colorbar");
  container.dataset.edge = "bottom";

  // "main" stacks one section per shown binding: sections run down the free axis (below each other
  // on horizontal docks, side by side on vertical), and inside a section the caption, gradient
  // strip, and tick labels stack per strip.
  const main = makeEl(doc, "div", "webpic-cbar_main");

  interface StripSection {
    readonly root: HTMLElement;
    update(binding: ColormapBinding | null, isHorizontal: boolean): void;
  }

  const makeSection = (): StripSection => {
    const root = makeEl(doc, "div", "webpic-cbar_sec");
    const caption = makeEl(doc, "span", "webpic-cbar_caption");
    const strip = makeEl(doc, "div", "webpic-cbar_strip");
    const canvas = doc.createElement("canvas");
    canvas.className = "webpic-cbar_canvas";
    // Collapsed-only overlay: the field key painted faintly over the gradient, so a docked
    // strip still names its field without the expanded side caption. Empty → hidden by CSS.
    const miniLabel = makeEl(doc, "span", "webpic-cbar_minilabel");
    miniLabel.setAttribute("aria-hidden", "true");
    strip.append(canvas, miniLabel);
    const ticks = makeEl(doc, "div", "webpic-cbar_ticks");
    root.append(caption, strip, ticks);

    // Last-painted gradient inputs, per strip: resizing the canvas clears its bitmap and re-baking
    // the 64-stop gradient is wasted on a window/scale/field edit (only the ticks move), so both are
    // gated on a real change of orientation/colormap.
    let paintedHorizontal: boolean | null = null;
    let paintedColormap: ColormapId | null = null;

    // Tick labels depend only on the window (center/width) + scale; skip the full tick-DOM rebuild
    // when those are unchanged — a colormap/field/orientation edit, or a window-drag frame that
    // rounds to the same labels, leaves the ticks identical. Field-agnostic, so a field swap isn't
    // keyed.
    let paintedTicksSig: string | null = null;
    const renderTicks = (binding: ColormapBinding | null): void => {
      const sig =
        binding === null
          ? "∅"
          : `${binding.window.center}|${binding.window.width}|${binding.scale}`;
      if (sig === paintedTicksSig) return;
      paintedTicksSig = sig;
      ticks.replaceChildren();
      if (binding === null) return;
      for (const tk of tickLabels(binding.window, binding.scale, TICK_TARGET)) {
        const span = makeEl(doc, "span", "webpic-cbar_tick");
        span.style.setProperty("--t", `${tk.t}`);
        span.textContent = tk.label;
        ticks.appendChild(span);
      }
    };

    const update = (binding: ColormapBinding | null, isHorizontal: boolean): void => {
      const colormap = binding?.colormap ?? DEFAULT_COLORMAP;
      // Render at the orientation's expanded pixel size; CSS scales the displayed strip (incl. the
      // collapse transition), so the canvas never snaps. A resize clears the bitmap, so any resize
      // forces a gradient repaint; a colormap change repaints in place.
      const orientationChanged = paintedHorizontal !== isHorizontal;
      if (orientationChanged) {
        canvas.width = isHorizontal ? 360 : 24;
        canvas.height = isHorizontal ? 24 : 220;
      }
      if (orientationChanged || paintedColormap !== colormap) {
        paintGradient(canvas, colormap, isHorizontal);
      }
      paintedHorizontal = isHorizontal;
      paintedColormap = colormap;
      caption.textContent = captionText(binding?.field);
      // No placeholder over the gradient — empty hides the collapsed overlay (CSS `:not(:empty)`).
      miniLabel.textContent = binding?.field ?? "";
      renderTicks(binding);
    };

    return { root, update };
  };

  const sections: StripSection[] = [];

  // Soft-warn badge: >MAX_COLORBARS distinct bindings among visible layers overflow the stack; the
  // "+N" pill names the stripless fields in its title. Informational only — no drag, no collapse.
  const warn = makeEl(doc, "span", "webpic-cbar_warn");
  warn.dataset.noDrag = "";
  warn.hidden = true;

  const actions = makeEl(doc, "div", "webpic-cbar_actions");
  actions.dataset.noDrag = ""; // never start a drag from the controls cluster
  const settingsBtn = makeIconButton(doc, "webpic-cbar_btn webpic-cbar_settings", ICON.settings, {
    ariaLabel: "Colormap settings",
  });
  settingsBtn.setAttribute("aria-haspopup", "dialog");
  settingsBtn.setAttribute("aria-expanded", "false");
  actions.append(settingsBtn);

  container.append(main, warn, actions);
  container.style.bottom = `${INITIAL_GAP_PX}px`; // first-paint dock; left set after repaint sizes it
  parent.appendChild(container);
  const disposeRaise = installRaise(container); // clicking the strip lifts it over the floating windows

  // Reconcile the section stack + warn badge with the store, repainting each strip. Returns whether
  // the stack's *shape* changed (section or overflow count) — that resizes the container, so the
  // caller owes a reflow; plain binding edits repaint in place.
  let overflowCount = 0;
  const repaint = (): boolean => {
    const edge = readEdge(container) ?? "bottom";
    const isHorizontal = edge === "top" || edge === "bottom";
    const state = store.getState();
    const activeId = selectActiveBinding(state)?.id ?? null;
    const { slots, overflow } = colorbarStack(selectVisibleBindings(state), activeId);

    // Always at least one section: an empty scene keeps the placeholder strip (default colormap, "—").
    const wanted = Math.max(1, slots.length);
    const shapeChanged = sections.length !== wanted || overflowCount !== overflow.length;
    while (sections.length < wanted) {
      const section = makeSection();
      sections.push(section);
      main.appendChild(section.root);
    }
    while (sections.length > wanted) sections.pop()?.root.remove();

    // With two strips up, cue which one the gear edits (the selected layer's binding) — but only
    // when it actually holds a slot; a hidden selected layer leaves the stack uncued.
    const shouldCueActive = slots.length > 1 && slots.some((b) => b.id === activeId);
    sections.forEach((section, i) => {
      const binding = slots[i] ?? null;
      if (shouldCueActive && binding !== null)
        section.root.dataset.active = String(binding.id === activeId);
      else delete section.root.dataset.active;
      section.update(binding, isHorizontal);
    });

    warn.hidden = overflow.length === 0;
    if (overflow.length > 0) {
      warn.textContent = `+${overflow.length}`;
      const fields = overflow.map((b) => b.field).join(", ");
      warn.title = `${slots.length + overflow.length} colormaps among visible layers — showing ${slots.length}. Without a strip: ${fields}. Layers can share a binding to declutter.`;
      warn.setAttribute("aria-label", warn.title);
    }
    overflowCount = overflow.length;
    return shapeChanged;
  };

  const settings = installColorbarSettings({
    parent,
    anchor: settingsBtn,
    colorbar: container,
    store,
  });
  settingsBtn.addEventListener("click", () => settings.toggle());

  const isCollapsed = (): boolean => container.classList.contains("collapsed");

  // The bottom-row coordinator decides collapse/migrate; this side applies them. The strip resizes
  // around its center via CSS (translate -50% on the free axis), so a collapse needs no anchor
  // change — the band's reflow just re-clamps + re-groups. `drag` is wired below; the band only
  // calls reflow from events/timers, never during construction.
  const band = createBottomBand({
    store,
    uiStore,
    strip: container,
    isCollapsed,
    setCollapsed: (next) => container.classList.toggle("collapsed", next),
    migrateToSide: (side) => {
      container.dataset.edge = side;
      container.dataset.docked = "true";
      repaint(); // reorient the gradient
    },
    reflow: () => {
      drag.reflow();
      settings.reposition();
    },
  });

  const drag = installDragSnap(container, {
    chromeSelector: CHROME_SELECTOR,
    shouldCenterFreeAxis: true, // collapse/expand pivots on the strip's center, not an edge
    onEdgeChange: () => {
      repaint();
      settings.reposition();
    },
    onSettled: band.onSettled,
  });

  // Click anywhere on the bar toggles collapse, except the gear or a just-ended drag's
  // trailing click. The settings popover is body-appended, so its clicks never reach here.
  container.addEventListener("click", (event) => {
    if (drag.wasDragging()) return;
    if (isInteractiveTarget(event)) return;
    band.collapse(!isCollapsed()); // manual: the user owns collapse from here
  });

  repaint();
  // Initial bottom-right dock in center-anchor form (the bottom edge is center-anchored on x via CSS
  // translateX(-50%)): place the strip's center so its right edge sits INITIAL_GAP from the viewport.
  const initialWidth = container.getBoundingClientRect().width;
  container.style.left = `${Math.round(doc.documentElement.clientWidth - INITIAL_GAP_PX - initialWidth / 2)}px`;
  container.style.right = "auto";

  // Two subscriptions drive the stack: the visible-binding set (layer add/remove/visibility/order +
  // edits to any shown binding; fresh array per state → shallow-compared) and the active binding
  // (layer-select, which keys the active cue + slot guarantee, plus edits to a hidden selection).
  // (dataRange feeds the settings slider's track, not the strips, so it needs no repaint here.) A
  // stack-shape change resizes the pill in place, so the band re-clamps / re-groups + re-fits.
  const onStoreChange = (): void => {
    if (repaint()) band.restack();
  };
  const subscriptions = createSubscriptions();
  subscriptions.on(store, selectVisibleBindings, onStoreChange, { equalityFn: shallow });
  subscriptions.on(store, selectActiveBinding, onStoreChange);
  bindChromeVisibility(subscriptions, uiStore, (isVisible) => {
    container.hidden = !isVisible;
    if (!isVisible) settings.close();
    band.setVisible(isVisible);
  });

  return () => {
    band.dispose();
    subscriptions.dispose();
    disposeRaise();
    drag.dispose();
    settings.dispose();
    container.remove();
  };
}
