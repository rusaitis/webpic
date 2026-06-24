import type { SimulationStore, UiStore } from "@store";
import { installOutsideClickDismiss, makeEl, makeIconButton } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";
import { ICON_CLOSE } from "./icons.ts";
import { POPOVER_GAP_PX } from "./layout.ts";
import { installScenePanel } from "./panels/scenePanel.ts";

// The left tool rail (the instance-first rail's first occupants): a magviz-style glass card of icon
// tabs on the operations/instruments axis, kept distinct from the data layers — a layer is born from an
// add-button; these are tools acting on the view. ui → store only. Hides with the global UI toggle.
//
//   • Axes & grid — opens a flyout beside the tab (speech-bubble tail) hosting the reference-frame
//     controls: the Scene panel mounts into the flyout body, its own title + folder bar stripped by the
//     .webpic-flyout_body CSS so the flyout header alone names it.
//   • Probe — toggles the draggable point marker (a value probe, not reference-frame chrome).
//
// The M4 layer add-buttons (+Volume/+Slice/…) and more tools (Selections/Reductions/Diagnostics/Theme/
// Layers) slot in here. The orientation gnomon stays on the bottom rail (camera chrome), absent here.

// 16×16 inline SVGs (no icon-font dep); fill/stroke come from the rail CSS, like ui/cameraRail.
const ICON = {
  // Axes + grid — the flyout's subject: a corner frame (left/bottom axes) crossed by grid lines.
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
  const ac = new AbortController();
  const { signal } = ac;
  const container = makeEl(doc, "div", "webpic-siderail");
  container.setAttribute("role", "toolbar");
  container.setAttribute("aria-label", "Tools");
  container.setAttribute("aria-orientation", "vertical");

  const makeButton = (control: string, icon: string): HTMLButtonElement =>
    makeIconButton(doc, "webpic-siderail_btn", icon, { control });

  const viewBtn = makeButton("view", ICON.view);
  viewBtn.setAttribute("aria-label", "Axes & grid");
  viewBtn.setAttribute("aria-haspopup", "dialog");
  viewBtn.setAttribute("aria-expanded", "false");
  const probeBtn = makeButton("probe", ICON.probe);

  container.append(viewBtn, probeBtn);
  parent.appendChild(container);

  // The flyout: a magviz-style panel opening to the right of the rail, its tail pointing back at the
  // View tab. The Scene panel mounts into the body; the flyout header carries the title (the pane's own
  // title + folder bar are CSS-stripped), so the section is never configured in two places.
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

  // Open state is local (a transient reveal, like the top bar's), not a docked-panel flag. Position is
  // recomputed on each open against the live rail rect so the tail lands on the View tab's center.
  let isOpen = false;
  const position = (): void => {
    const rail = container.getBoundingClientRect();
    const btn = viewBtn.getBoundingClientRect();
    flyout.style.left = `${Math.round(rail.right + POPOVER_GAP_PX)}px`;
    const arrowY = btn.top + btn.height / 2;
    const height = flyout.offsetHeight; // valid only while shown — hidden is cleared before this runs
    const viewportH = doc.documentElement.clientHeight;
    const top = Math.max(8, Math.min(arrowY - height / 2, viewportH - height - 8));
    flyout.style.top = `${Math.round(top)}px`;
    flyout.style.setProperty("--arrow-pos", `${Math.round(arrowY - top)}px`);
  };
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

  // Escape closes (focus returns to the tab); an outside pointer-down dismisses — same shape as the
  // bottom rail's coords card (shared installOutsideClickDismiss).
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

  const onResize = (): void => {
    if (isOpen) position();
  };
  doc.defaultView?.addEventListener("resize", onResize, { signal });

  // Reflect store state: probe aria-pressed + label (also its slide-out hover label). The View tab's
  // open state is local, so it carries no store subscription.
  const applyProbe = (show: boolean): void => {
    probeBtn.setAttribute("aria-pressed", String(show));
    probeBtn.setAttribute(
      "aria-label",
      show ? "Hide point marker" : "Point marker — probe a value",
    );
  };
  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (!visible) setOpen(false); // don't strand the flyout over hidden UI; F re-reveals the rail only
  };

  setOpen(false);
  applyProbe(store.getState().overlay.showPicker);
  applyVisible(uiStore.getState().isUiVisible);

  const unsubs = [
    store.subscribe((s) => s.overlay.showPicker, applyProbe),
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
  ];

  return () => {
    ac.abort();
    for (const unsub of unsubs) unsub();
    disposeOutsideDismiss();
    sceneDispose();
    flyout.remove();
    container.remove();
  };
}
