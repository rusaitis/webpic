import { LAYER_KIND_ORDER, LAYER_KINDS, type SimulationStore, type UiStore } from "@store";
import { installOutsideClickDismiss, makeEl, makeIconButton } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";
import { ICON_CLOSE } from "./icons.ts";
import { LAYER_KIND_ICON, PARTICLES_PLACEHOLDER_ICON } from "./layerIcons.ts";
import { positionArrowFlyout } from "./layout.ts";
import { installScenePanel } from "./panels/scenePanel.ts";
import { installRailMenu, type RailMenuHandle, type RailMenuItem } from "./railMenu.ts";
import { createShortcutRegistry } from "./shortcuts.ts";
import { createSubscriptions } from "./subscriptions.ts";

// The left tool rail (the instance-first rail). Three groups on the operations axis: a Layers toggle,
// the layer add-buttons (+Volume/+Slice/+Field lines — each opens a click-menu of existing instances
// plus "Add new"), and tool buttons (Axes & grid, Probe, Developer, + reserved Reductions/
// Selections/Theme). ui → store only; hides with the global UI toggle.
//
//   • Axes & grid — opens a flyout beside the tab hosting the reference-frame (Scene) controls.
//   • Probe — toggles the draggable value-probe marker.
//   • Developer — opens the Developer window (frame timing + dev toggles; the panels.dev flag).
//
// Layer settings live in the Layers panel + colorbar, not here — these are tools, not layers.

// 16×16 inline SVGs; fill/stroke come from the rail CSS, like ui/cameraRail. Layer-kind glyphs come
// from ui/layerIcons (shared with the Layers panel); these are the rail-only tool glyphs.
const ICON = {
  // Axes + grid — a corner frame crossed by grid lines.
  view: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5h11M2.5 13.5V2.5"/><path d="M2.5 9.8h11M2.5 6.1h11"/><path d="M6.2 13.5V2.5M9.9 13.5V2.5"/></svg>`,
  // A target around a point — the value-probe marker.
  probe: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8h2.5M12 8h2.5"/></svg>`,
  // Three stacked sheets — the Layers overlay toggle.
  layers: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2l5.5 3-5.5 3-5.5-3z"/><path d="M2.5 8L8 11l5.5-3M2.5 11L8 14l5.5-3"/></svg>`,
  // A funnel — reductions (reserved).
  reductions: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11l-4 5v4l-3 1.5V8.5z"/></svg>`,
  // Marquee corners — selections (reserved).
  selections: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h2.5M10.5 3.5H13M3 12.5h2.5M10.5 12.5H13M3 3.5v2.5M3 10v2.5M13 3.5v2.5M13 10v2.5"/></svg>`,
  // An ECG pulse — the Developer window's frame timing.
  developer: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8h3l1.8-4.5L9 12.5l1.8-4.5h3.7"/></svg>`,
  // A half-filled disc — theme (reserved).
  theme: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none"/></svg>`,
} as const;

export function installSideRail(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const ac = new AbortController();
  const { signal } = ac;
  const container = makeEl(doc, "div", "webpic-siderail");
  container.setAttribute("role", "toolbar");
  container.setAttribute("aria-label", "Tools");
  container.setAttribute("aria-orientation", "vertical");

  const makeButton = (control: string, icon: string): HTMLButtonElement =>
    makeIconButton(doc, "webpic-siderail_btn", icon, { control });
  const addSeparator = (): void => {
    container.appendChild(makeEl(doc, "div", "webpic-siderail_sep"));
  };

  // Layers toggle (top).
  const layersBtn = makeButton("layers", ICON.layers);
  layersBtn.setAttribute("aria-label", "Layers");
  layersBtn.setAttribute("aria-pressed", "false");
  layersBtn.addEventListener("click", () => uiStore.getState().toggleLayersPanel(), { signal });
  container.append(layersBtn);
  addSeparator();

  // Add-button group — one per renderable primitive, each opening an instance menu.
  const menus: RailMenuHandle[] = [];
  for (const kind of LAYER_KIND_ORDER) {
    const label = LAYER_KINDS[kind].label;
    const btn = makeButton(`add-${kind}`, LAYER_KIND_ICON[kind]);
    btn.setAttribute("aria-label", `${label} layers`);
    btn.setAttribute("aria-haspopup", "menu");
    container.append(btn);
    const menu = installRailMenu({
      anchor: btn,
      parent,
      title: `${label} layers`,
      getItems: (): readonly RailMenuItem[] =>
        store
          .getState()
          .layers.filter((layer) => layer.kind === kind)
          .map((layer) => ({ id: layer.id, label: layer.field })),
      getSelected: () => store.getState().selectedLayerId,
      onPick: (id) => {
        store.getState().selectLayer(id);
        uiStore.getState().setLayersPanelVisible(true);
      },
      onAddNew: () => {
        store.getState().addLayerOfKind(kind); // selects the new layer; open settings on it
        uiStore.getState().setLayerSettingsVisible(true);
      },
    });
    menus.push(menu);
  }
  // Particle rendering hasn't landed — present but disabled so the rail reads complete.
  const particlesBtn = makeButton("add-particles", PARTICLES_PLACEHOLDER_ICON);
  particlesBtn.setAttribute("aria-label", "Particles — v0.2");
  particlesBtn.disabled = true;
  container.append(particlesBtn);
  addSeparator();

  // Tool group.
  const viewBtn = makeButton("view", ICON.view);
  viewBtn.setAttribute("aria-label", "Axes & grid");
  viewBtn.setAttribute("aria-haspopup", "dialog");
  viewBtn.setAttribute("aria-expanded", "false");
  const probeBtn = makeButton("probe", ICON.probe);
  // data-control stays "diagnostics": scripts/harness/pageProbes.ts drives the perf gate through it.
  const devBtn = makeButton("diagnostics", ICON.developer);
  devBtn.setAttribute("aria-label", "Developer / frame timing");
  devBtn.setAttribute("aria-pressed", "false");
  devBtn.addEventListener("click", () => uiStore.getState().togglePanel("dev"), { signal });
  const reductionsBtn = makeButton("reductions", ICON.reductions);
  reductionsBtn.setAttribute("aria-label", "Reductions — v0.2");
  reductionsBtn.disabled = true;
  const selectionsBtn = makeButton("selections", ICON.selections);
  selectionsBtn.setAttribute("aria-label", "Selections — v0.2");
  selectionsBtn.disabled = true;
  // Theme cycler: each click asks the app theme bridge for the next bundled theme. Enabled only
  // once the bridge seeds themeName — a boot without a theme catalog (headless/embed) keeps it inert.
  const themeBtn = makeButton("theme", ICON.theme);
  themeBtn.setAttribute("aria-label", "Cycle theme");
  themeBtn.addEventListener("click", () => uiStore.getState().requestThemeCycle(), { signal });
  container.append(viewBtn, probeBtn, devBtn, reductionsBtn, selectionsBtn, themeBtn);
  parent.appendChild(container);

  // The Axes & grid flyout (unchanged): a panel opening to the right of the View tab, tail pointing
  // back at it; the Scene panel mounts into the body (its own title + folder bar CSS-stripped).
  const flyout = makeEl(doc, "div", "webpic-flyout");
  flyout.setAttribute("role", "dialog");
  flyout.setAttribute("aria-label", "Axes & grid");
  flyout.hidden = true;
  const arrow = makeEl(doc, "div", "webpic-flyout_arrow");
  const header = makeEl(doc, "div", "webpic-flyout_header");
  const title = makeEl(doc, "span", "webpic-flyout_title");
  title.textContent = "Axes & grid";
  const closeBtn = makeIconButton(doc, "webpic-flyout_close", ICON_CLOSE, { ariaLabel: "Close" });
  header.append(title, closeBtn);
  const body = makeEl(doc, "div", "webpic-flyout_body");
  flyout.append(arrow, header, body);
  parent.appendChild(flyout);

  const sceneDispose = installScenePanel(body, store);

  let isOpen = false;
  const position = (): void =>
    positionArrowFlyout(
      flyout,
      container.getBoundingClientRect(),
      viewBtn.getBoundingClientRect(),
      doc,
    );
  const setOpen = (next: boolean): void => {
    isOpen = next;
    flyout.hidden = !next;
    viewBtn.setAttribute("aria-pressed", String(next));
    viewBtn.setAttribute("aria-expanded", String(next));
    if (next) position();
  };

  viewBtn.addEventListener("click", () => setOpen(!isOpen), { signal });
  closeBtn.addEventListener(
    "click",
    () => {
      setOpen(false);
      viewBtn.focus();
    },
    { signal },
  );
  probeBtn.addEventListener(
    "click",
    () => {
      const state = store.getState();
      state.setOverlayShowPicker(!state.overlay.showPicker);
    },
    { signal },
  );

  const onDocKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && isOpen) {
      setOpen(false);
      viewBtn.focus();
    }
  };
  doc.addEventListener("keydown", onDocKeyDown, { signal });
  const disposeOutsideDismiss = installOutsideClickDismiss(doc, {
    overlay: flyout,
    trigger: viewBtn,
    isOpen: () => isOpen,
    onDismiss: () => setOpen(false),
  });

  // The Add-volume shortcut (DESIGN default "V"). ("S" is intentionally unbound — it collides with
  // the W/S dolly; +Slice is rail-only.)
  createShortcutRegistry(doc, signal).register("v", () =>
    store.getState().addLayerOfKind("volume"),
  );

  const onResize = (): void => {
    if (isOpen) position();
  };
  doc.defaultView?.addEventListener("resize", onResize, { signal });

  const applyProbe = (show: boolean): void => {
    probeBtn.setAttribute("aria-pressed", String(show));
    probeBtn.setAttribute(
      "aria-label",
      show ? "Hide point marker" : "Point marker — probe a value",
    );
  };
  const applyLayersPressed = (open: boolean): void => {
    layersBtn.setAttribute("aria-pressed", String(open));
  };
  const applyDevPressed = (open: boolean): void => {
    devBtn.setAttribute("aria-pressed", String(open));
  };
  const applyThemeName = (name: string | null): void => {
    themeBtn.disabled = name === null;
    themeBtn.title = name === null ? "Theme" : `Theme: ${name} — click to cycle`;
  };
  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (!visible) {
      setOpen(false); // don't strand the flyout / menus over hidden UI; F re-reveals the rail
      for (const menu of menus) menu.close();
    }
  };

  setOpen(false);
  applyProbe(store.getState().overlay.showPicker);
  applyLayersPressed(uiStore.getState().isLayersPanelOpen);
  applyDevPressed(uiStore.getState().panels.dev ?? false);
  applyThemeName(uiStore.getState().themeName);
  applyVisible(uiStore.getState().isUiVisible);

  const subs = createSubscriptions();
  subs.on(store, (s) => s.overlay.showPicker, applyProbe);
  subs.on(
    store,
    (s) => s.layers,
    () => {
      for (const menu of menus) menu.refresh();
    },
  );
  subs.on(uiStore, (s) => s.isLayersPanelOpen, applyLayersPressed);
  subs.on(uiStore, (s) => s.panels.dev ?? false, applyDevPressed);
  subs.on(uiStore, (s) => s.themeName, applyThemeName);
  subs.on(uiStore, (s) => s.isUiVisible, applyVisible);

  return () => {
    ac.abort();
    subs.dispose();
    for (const menu of menus) menu.dispose();
    disposeOutsideDismiss();
    sceneDispose();
    flyout.remove();
    container.remove();
  };
}
