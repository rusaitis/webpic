import type { CameraProjection, SimulationStore, UiStore } from "@store";
import { bindChromeVisibility } from "../chromeVisibility.ts";
import { makeEl } from "../controls/dom.ts";
import type { Disposer } from "../controls/index.ts";
import { createSubscriptions } from "../subscriptions.ts";
import { buildActionsPanel } from "./actionsPanel.ts";
import { installDatasetPicker } from "./datasetPicker.ts";
import { installFieldPicker } from "./fieldPicker.ts";
import { bindReveal, makeTopBarIconButton } from "./parts.ts";
import { installTimeControl } from "./timeControl.ts";

// The top menu bar: a brand, a dataset dropdown, a "content" button listing the available fields, a
// timestep chip that opens a scrub popover, a projection chip + PNG-export button, and a chevron
// cluster of placeholder actions. Each of those lives in its own module; this file is the assembly —
// what the bar contains, in what order, and the three things that cross between them: at most one
// overlay open at a time, the compact-layout relocate, and the global hide. ui -> store only.

// 16×16 inline SVGs (no icon-font dep); `fill: none; stroke: currentColor` come from the bar CSS.
const BRAND_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 9.4c2.1-4.8 4.4-4.8 6.4 0"/><path d="M8 6.6c2 4.8 4.3 4.8 6.4 0"/></svg>`;
const ICON_EXPORT = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><circle cx="6" cy="6.5" r="1"/><path d="m3 11 3-2.5 2.5 2 2-1.5 2.5 2.5"/></svg>`;

const COMPACT_QUERY = "(max-width: 560px)";

// Brand: an inline-SVG field-line mark + wordmark (no logo asset exists; this matches the boot
// splash identity and tints with the theme accent).
function makeBrand(doc: Document): HTMLElement {
  const brand = makeEl(doc, "div", "webpic-topbar_brand");
  const mark = makeEl(doc, "span", "webpic-icon webpic-topbar_mark");
  mark.innerHTML = BRAND_SVG;
  const word = makeEl(doc, "span", "webpic-topbar_word");
  word.textContent = "webpic";
  brand.append(mark, word);
  return brand;
}

// The projection chip mirrors ui/camera/bottomRail's toggle through the same setProjection intent —
// a second trigger, not a second model.
function makeProjectionChip(
  doc: Document,
  store: SimulationStore,
): {
  element: HTMLButtonElement;
  apply: (projection: CameraProjection) => void;
} {
  const element = makeEl(doc, "button", "webpic-topbar_chip webpic-topbar_proj");
  element.type = "button";
  element.dataset.control = "projection";
  const apply = (projection: CameraProjection): void => {
    const isOrthographic = projection === "orthographic";
    element.textContent = isOrthographic ? "ortho" : "persp";
    element.title = isOrthographic
      ? "Orthographic — switch to perspective (O)"
      : "Perspective — switch to orthographic (O)";
  };
  apply(store.getState().projection);
  element.addEventListener("click", () => {
    const state = store.getState();
    state.toggleProjection();
  });
  return { element, apply };
}

export function installTopBar(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const container = makeEl(doc, "div", "webpic-topbar");
  container.setAttribute("role", "toolbar");
  container.setAttribute("aria-label", "Application");
  const abortController = new AbortController();
  const { signal } = abortController;

  // Topbar overlays are mutually exclusive: opening one (a picker popover or a pinned reveal) closes
  // the others, so at most one floats at a time. Each registers a closer once built; with outside-
  // pointerdown dismissal off, this + the trigger toggle + Escape are the only ways one closes.
  const overlayClosers = new Map<string, () => void>();
  const closeOverlaysExcept = (keep: string): void => {
    for (const [id, close] of overlayClosers) if (id !== keep) close();
  };

  const dataset = installDatasetPicker(doc, store, () => closeOverlaysExcept("dataset"));
  const field = installFieldPicker(doc, store, () => closeOverlaysExcept("field"));
  const time = installTimeControl(doc, store);
  const actions = buildActionsPanel(doc);
  const projection = makeProjectionChip(doc, store);
  overlayClosers.set("dataset", dataset.close);
  overlayClosers.set("field", field.close);

  const exportBtn = makeTopBarIconButton(doc, "export", ICON_EXPORT, "Export PNG (P)");
  exportBtn.addEventListener("click", () => uiStore.getState().requestScreenshot());

  container.append(
    makeBrand(doc),
    dataset.element,
    field.element,
    time.element,
    projection.element,
    exportBtn,
    actions.element,
  );
  parent.appendChild(container);

  // Both reveals are sticky pins: an outside scene click never dismisses one; only re-clicking the
  // trigger, Escape, or opening another overlay (via onOpen) closes it.
  const timeReveal = bindReveal(time.element, time.chip, signal, () => closeOverlaysExcept("time"));
  const actionsReveal = bindReveal(actions.element, actions.chevron, signal, () =>
    closeOverlaysExcept("actions"),
  );
  overlayClosers.set("time", () => timeReveal.setExpanded(false));
  overlayClosers.set("actions", () => actionsReveal.setExpanded(false));

  // Responsive overflow — below a phone-width threshold the scrub can't share the bar with the
  // pickers, so it relocates into the chevron's panel and the bar drops to its compact layout. Both
  // reveals close on each switch so nothing floats over the move.
  const compactQuery = doc.defaultView?.matchMedia(COMPACT_QUERY) ?? null;
  const applyCompact = (isCompact: boolean): void => {
    container.classList.toggle("is-compact", isCompact);
    timeReveal.setExpanded(false);
    actionsReveal.setExpanded(false);
    if (isCompact) actions.panel.appendChild(time.element);
    else container.insertBefore(time.element, projection.element);
  };
  applyCompact(compactQuery?.matches ?? false);
  compactQuery?.addEventListener("change", (event) => applyCompact(event.matches), { signal });

  time.rebuild();

  const subscriptions = createSubscriptions();
  subscriptions.on(
    store,
    (s) => s.datasetId,
    () => {
      dataset.syncLabel();
      dataset.refresh();
    },
  );
  subscriptions.on(store, (s) => s.dataset, dataset.syncLabel); // run metadata lands after the id
  subscriptions.on(store, (s) => s.projection, projection.apply);
  subscriptions.on(
    store,
    (s) => s.activeField,
    () => {
      field.syncLabel();
      field.refresh();
    },
  );
  subscriptions.on(store, (s) => s.availableFields, field.refresh);
  subscriptions.on(store, (s) => s.availableSteps, time.rebuild);
  subscriptions.on(store, (s) => s.currentStep, time.syncCursor);
  bindChromeVisibility(subscriptions, uiStore, (isVisible) => {
    container.hidden = !isVisible;
    if (!isVisible) {
      dataset.close();
      field.close();
      timeReveal.setExpanded(false); // don't restore a pinned reveal when the bar is shown again
      actionsReveal.setExpanded(false);
    }
  });

  return () => {
    subscriptions.dispose();
    abortController.abort();
    time.dispose();
    dataset.dispose();
    field.dispose();
    container.remove();
  };
}
