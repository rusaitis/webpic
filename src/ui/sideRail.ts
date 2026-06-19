import type { SimulationStore, UiStore } from "@store";
import { makeEl } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";

// The left tool rail (the instance-first rail's first occupants): vertical icon toggles for the
// operations/instruments axis, deliberately kept distinct from the data layers — a layer is born from
// an add-button; these are tools acting on the view. ui → store only: each button dispatches a typed
// intent or reads a slice, never imports render. Hides with the global UI toggle, like ui/cameraRail.
//
// Today it carries the two tools peeled out of the Scene panel's old grab-bag:
//   • View  — toggles the docked Scene panel (the in-scene axes/grid reference-frame config).
//   • Probe — toggles the draggable point marker (a value probe, not reference-frame chrome).
// The M4 layer add-buttons (+Volume/+Slice/…) and the rest of the tools (Selections/Reductions/
// Diagnostics/Theme/Layers) slot in here as further entries. The orientation gnomon stays on the
// bottom rail (camera chrome), so it is intentionally absent here.

// The Scene panel's registry key (ui/panels/registry.ts) — the View toggle drives its visibility.
const SCENE_PANEL = "scene";

// 16×16 inline SVGs (no icon-font dep); fill/stroke come from the rail CSS, like ui/cameraRail.
const ICON = {
  // Axes + grid — the Scene panel's subject: a corner frame (left/bottom axes) crossed by grid lines.
  view: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5h11M2.5 13.5V2.5"/><path d="M2.5 9.8h11M2.5 6.1h11"/><path d="M6.2 13.5V2.5M9.9 13.5V2.5"/></svg>`,
  // A target around a point — the value-probe marker: outer ring, filled centre, four crosshair ticks.
  probe: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8h2.5M12 8h2.5"/></svg>`,
} as const;

export function installSideRail(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const container = makeEl(doc, "div", "webpic-siderail");
  container.setAttribute("role", "toolbar");
  container.setAttribute("aria-label", "Tools");
  container.setAttribute("aria-orientation", "vertical");

  const makeButton = (control: string, icon: string): HTMLButtonElement => {
    const btn = makeEl(doc, "button", "webpic-siderail_btn");
    btn.type = "button";
    btn.dataset.control = control;
    btn.innerHTML = icon;
    return btn;
  };

  const viewBtn = makeButton("view", ICON.view);
  const probeBtn = makeButton("probe", ICON.probe);

  // Panels default shown (?? true), so a fresh store reads the View toggle as pressed (panel open).
  const isPanelOpen = (): boolean => uiStore.getState().panels[SCENE_PANEL] ?? true;
  viewBtn.addEventListener("click", () => uiStore.getState().togglePanel(SCENE_PANEL));
  probeBtn.addEventListener("click", () => {
    const state = store.getState();
    state.setOverlayShowPicker(!state.overlay.showPicker);
  });

  container.append(viewBtn, probeBtn);
  parent.appendChild(container);

  // Reflect store state onto the toggles: aria-pressed drives the accent-tint + assistive state;
  // aria-label is both the accessible name and the slide-out hover label (the CSS ::after reads it),
  // so there's no native `title` to double up with the pill.
  const applyView = (open: boolean): void => {
    viewBtn.setAttribute("aria-pressed", String(open));
    viewBtn.setAttribute("aria-label", open ? "Hide scene (axes & grid)" : "Scene — axes & grid");
  };
  const applyProbe = (show: boolean): void => {
    probeBtn.setAttribute("aria-pressed", String(show));
    probeBtn.setAttribute(
      "aria-label",
      show ? "Hide point marker" : "Point marker — probe a value",
    );
  };
  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
  };

  applyView(isPanelOpen());
  applyProbe(store.getState().overlay.showPicker);
  applyVisible(uiStore.getState().isUiVisible);

  // Per-leaf selectors: the panel boolean (resolved with the default) and the picker flag fire only on
  // a real change; isUiVisible mirrors the global toggle the same way as the bottom rail.
  const unsubs = [
    uiStore.subscribe((s) => s.panels[SCENE_PANEL] ?? true, applyView),
    store.subscribe((s) => s.overlay.showPicker, applyProbe),
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
    container.remove();
  };
}
