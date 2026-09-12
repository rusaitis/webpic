import { DATASET_CATALOG } from "@schema/datasets.ts";
import type { FieldName } from "@schema/types.ts";
import type { CameraProjection, SimulationStore, UiStore } from "@store";
import { installChromeVisibility } from "../chromeVisibility.ts";
import { makeEl } from "../controls/dom.ts";
import { createPopover, type Disposer, type RangeValue } from "../controls/index.ts";
import { createRangeControl } from "../controls/rangeControl.ts";
import { ICON_CARET_FLAT } from "../icons.ts";
import { createSubscriptions } from "../subscriptions.ts";
import {
  datasetLabel,
  fieldButtonLabel,
  fieldMetaRows,
  orderedFieldNames,
  stepAt,
  stepIndex,
  stepReadout,
} from "./info.ts";
import {
  installReveal,
  makePickerButton,
  makeStepButton,
  makeTopBarCaret,
  makeTopBarIconButton,
} from "./parts.ts";

// The top menu bar: a brand, a dataset dropdown (label prefers the run name the data carries), a
// "content" button listing the available fields, a timestep chip that opens a scrub popover, a
// projection chip + PNG-export button, and a chevron cluster of disabled placeholder actions — both
// reveals share one installReveal. On a narrow viewport (matchMedia) the bar goes compact: the scrub
// relocates into the chevron's panel so the row still fits. ui → store only. Hides with the global UI
// toggle, force-closing its popovers + reveal so neither floats over a hidden bar.

// 16×16 inline SVGs (no icon-font dep); `fill: none; stroke: currentColor` come from the bar CSS.
const BRAND_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 9.4c2.1-4.8 4.4-4.8 6.4 0"/><path d="M8 6.6c2 4.8 4.3 4.8 6.4 0"/></svg>`;
const ICON = {
  prev: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 3 6 8l5.5 5"/><path d="M5 3v10"/></svg>`,
  next: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3 10 8l-5.5 5"/><path d="M11 3v10"/></svg>`,
  upload: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.5V2.5M5 5.5 8 2.5l3 3"/><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>`,
  layers: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 1.5 5.5 8 9l6.5-3.5L8 2Z"/><path d="m1.5 9.5 6.5 3.5 6.5-3.5"/></svg>`,
  export: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><circle cx="6" cy="6.5" r="1"/><path d="m3 11 3-2.5 2.5 2 2-1.5 2.5 2.5"/></svg>`,
  layout: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M8 3.5v9"/></svg>`,
} as const;

export function installTopBar(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const container = makeEl(doc, "div", "webpic-topbar");
  container.setAttribute("role", "toolbar");
  container.setAttribute("aria-label", "Application");

  // Topbar overlays are mutually exclusive: opening one (a picker popover or a pinned reveal) closes
  // the others, so at most one floats at a time. Each registers a closer once built; with outside-
  // pointerdown dismissal off, this + the trigger toggle + Escape are the only ways one closes.
  const overlayClosers = new Map<string, () => void>();
  const closeOverlaysExcept = (keep: string): void => {
    for (const [id, close] of overlayClosers) if (id !== keep) close();
  };

  // Brand: an inline-SVG field-line mark + wordmark (no logo asset exists; this matches the boot
  // splash identity and tints with the theme accent).
  const brand = makeEl(doc, "div", "webpic-topbar_brand");
  const mark = makeEl(doc, "span", "webpic-topbar_mark");
  mark.innerHTML = BRAND_SVG;
  const word = makeEl(doc, "span", "webpic-topbar_word");
  word.textContent = "webpic";
  brand.append(mark, word);

  // Dataset picker — switches the built-in dataset. The button label prefers the loaded dataset's
  // run name (attrs.run / simulation_toml, via datasetLabel's chain) over the static catalog entry.
  const datasetBtn = makePickerButton(doc, "dataset", "webpic-topbar_dataset", "Dataset");
  const datasetLabelEl = makeEl(doc, "span", "webpic-topbar_label");
  const syncDatasetLabel = (): void => {
    const state = store.getState();
    datasetLabelEl.textContent = datasetLabel(state.datasetId, state.dataset?.metadata);
  };
  syncDatasetLabel();
  datasetBtn.append(datasetLabelEl, makeTopBarCaret(doc));

  const datasetItems = DATASET_CATALOG.map((d) => ({ value: d.id, label: d.label }));
  const datasetPopover = createPopover<{ value: string; label: string }>({
    anchor: datasetBtn,
    shouldDismissOnOutside: false,
    onOpen: () => closeOverlaysExcept("dataset"),
    getItems: () => datasetItems,
    getSelected: () => store.getState().datasetId,
    onSelect: (id) => store.getState().selectDataset(id),
    renderRow: (rowDoc, item) => {
      const span = makeEl(rowDoc, "span", "webpic-popover_text");
      span.textContent = item.label;
      return span;
    },
  });
  overlayClosers.set("dataset", () => datasetPopover.close());

  // Content picker — the available fields and their metadata; selecting one sets the active field.
  const fieldBtn = makePickerButton(doc, "field", "webpic-topbar_field", "Dataset contents");
  const fieldLabelEl = makeEl(doc, "span", "webpic-topbar_label");
  fieldLabelEl.textContent = fieldButtonLabel(store.getState().activeField);
  fieldBtn.append(fieldLabelEl, makeTopBarCaret(doc));

  const fieldItems = (): { value: FieldName }[] =>
    orderedFieldNames(store.getState().availableFields, store.getState().activeField).map(
      (name) => ({ value: name }),
    );
  const renderFieldRow = (rowDoc: Document, name: FieldName): HTMLElement => {
    const wrap = makeEl(rowDoc, "div", "webpic-popover_field");
    const title = makeEl(rowDoc, "span", "webpic-popover_text");
    title.textContent = fieldButtonLabel(name);
    const meta = makeEl(rowDoc, "span", "webpic-popover_meta");
    const unit = fieldMetaRows(name).find((r) => r.label === "Unit")?.value;
    meta.textContent = unit && unit !== "—" ? `${name} · ${unit}` : name;
    wrap.append(title, meta);
    return wrap;
  };
  const fieldPopover = createPopover<{ value: FieldName }>({
    anchor: fieldBtn,
    className: "is-fields",
    shouldDismissOnOutside: false,
    onOpen: () => closeOverlaysExcept("field"),
    getItems: fieldItems,
    getSelected: () => store.getState().activeField,
    onSelect: (name) => void store.getState().selectField(name),
    renderRow: (rowDoc, item) => renderFieldRow(rowDoc, item.value),
  });
  overlayClosers.set("field", () => fieldPopover.close());

  // Time control — a compact "step N" chip that reveals a scrub popover (track + prev/next) on
  // hover/tap, so the resting bar stays a single centered line. The custom range control bakes
  // min/max/step at construction, so a changed domain rebuilds it; a cursor move reflects via set()
  // without echo. Disabled (≤1 step) dims the chip + gates it shut.
  const timeWrap = makeEl(doc, "div", "webpic-topbar_time webpic-topbar_reveal");
  const timeChip = makeEl(doc, "button", "webpic-topbar_chip");
  timeChip.type = "button";
  timeChip.dataset.control = "time";
  timeChip.title = "Timestep";
  timeChip.setAttribute("aria-haspopup", "true");
  timeChip.setAttribute("aria-expanded", "false");
  const stepLabelEl = makeEl(doc, "span", "webpic-topbar_step");
  timeChip.append(stepLabelEl, makeTopBarCaret(doc));

  const timePop = makeEl(doc, "div", "webpic-topbar_pop webpic-topbar_time-pop");
  const prevBtn = makeStepButton(doc, "step-prev", ICON.prev, "Previous step");
  const nextBtn = makeStepButton(doc, "step-next", ICON.next, "Next step");
  timePop.append(prevBtn, nextBtn); // the scrub track is inserted between them by rebuildRange
  timeWrap.append(timeChip, timePop);

  let range: ReturnType<typeof createRangeControl> | null = null;
  let steps: readonly number[] = []; // the availableSteps snapshot the live control was built against

  const dispatchIndex = (index: number): void => {
    const step = stepAt(index, steps);
    if (step !== undefined) store.getState().setStep(step); // self-guards out-of-domain + no-ops
  };
  // The grip is a focusable <div role="slider">, not an <input>, so bare-key shortcuts (F/C) reach the
  // document handlers while it's focused — unlike a native <input> slider.
  const onScrub = (v: RangeValue): void => {
    if (typeof v !== "number") return; // single mode emits a number
    stepLabelEl.textContent = stepReadout(v, steps); // live readout in the resting chip
    dispatchIndex(v);
  };
  const rebuildRange = (): void => {
    range?.dispose();
    steps = store.getState().availableSteps;
    const index = stepIndex(store.getState().currentStep, steps);
    range = createRangeControl(doc, {
      min: 0,
      max: Math.max(0, steps.length - 1),
      value: index,
      step: 1,
      text: false, // bare track + grip; the readout lives in the chip's stepLabelEl, not a coupled field
      format: (i) => stepReadout(i, steps), // aria-valuetext announces "step 10", not the bare index
      onInput: onScrub,
      onChange: onScrub,
    });
    range.element.classList.add("webpic-topbar_track");
    const disabled = steps.length <= 1;
    range.setDisabled(disabled);
    timePop.insertBefore(range.element, nextBtn); // keep [prev, track, next] inside the popover
    prevBtn.disabled = disabled;
    nextBtn.disabled = disabled;
    timeChip.disabled = disabled;
    timeWrap.classList.toggle("is-disabled", disabled); // dims the chip + gates the reveal (CSS)
    stepLabelEl.textContent = stepReadout(index, steps);
  };
  const stepBy = (delta: number): void => {
    dispatchIndex(stepIndex(store.getState().currentStep, steps) + delta);
  };
  prevBtn.addEventListener("click", () => stepBy(-1));
  nextBtn.addEventListener("click", () => stepBy(1));

  // Reflect an externally-dispatched setStep onto the grip without echoing onChange (set()-in).
  const syncCursor = (): void => {
    const index = stepIndex(store.getState().currentStep, steps);
    range?.set(index);
    stepLabelEl.textContent = stepReadout(index, steps);
  };

  // Camera/export cluster (DESIGN §UI's top-bar "camera/projection, export"). The projection chip
  // mirrors ui/camera/bottomRail's toggle through the same setProjection intent — a second trigger, not a
  // second model; export fires the screenshot chain the P shortcut uses (screenshotBridge owns
  // the pill, single-flight, and the download).
  const projChip = makeEl(doc, "button", "webpic-topbar_chip webpic-topbar_proj");
  projChip.type = "button";
  projChip.dataset.control = "projection";
  const applyProjection = (projection: CameraProjection): void => {
    const ortho = projection === "orthographic";
    projChip.textContent = ortho ? "ortho" : "persp";
    projChip.title = ortho
      ? "Orthographic — switch to perspective (O)"
      : "Perspective — switch to orthographic (O)";
  };
  applyProjection(store.getState().projection);
  projChip.addEventListener("click", () => {
    const state = store.getState();
    state.setProjection(state.projection === "orthographic" ? "perspective" : "orthographic");
  });

  const exportBtn = makeTopBarIconButton(doc, "export", ICON.export, "Export PNG (P)");
  exportBtn.addEventListener("click", () => uiStore.getState().requestScreenshot());

  // Hover-revealed actions — a chevron at the right edge opens a popover of (inert placeholder)
  // action buttons. Same reveal mechanism + glass-card (.webpic-topbar_pop) as the time chip.
  // The popover is absolute, so it never widens the bar.
  const actionsWrap = makeEl(doc, "div", "webpic-topbar_reveal");
  const chevron = makeTopBarIconButton(doc, "more", ICON_CARET_FLAT, "More actions");
  chevron.classList.add("webpic-topbar_chevron");
  chevron.setAttribute("aria-haspopup", "true");
  chevron.setAttribute("aria-expanded", "false");
  const actions = makeEl(doc, "div", "webpic-topbar_pop webpic-topbar_actions");
  const actionsGrid = makeEl(doc, "div", "webpic-topbar_actions-grid");
  const placeholder = (control: string, icon: string, title: string): HTMLButtonElement => {
    const btn = makeTopBarIconButton(doc, control, icon, `${title} (coming soon)`);
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    return btn;
  };
  actionsGrid.append(
    placeholder("upload", ICON.upload, "Upload data"),
    placeholder("layers", ICON.layers, "Layers"),
    placeholder("layout", ICON.layout, "Compare / layout"),
  );
  actions.append(actionsGrid); // the compact bar appends the relocated time scrub below this grid
  actionsWrap.append(chevron, actions);

  container.append(brand, datasetBtn, fieldBtn, timeWrap, projChip, exportBtn, actionsWrap);
  parent.appendChild(container);

  // Both reveals share one AbortController; installReveal wires each
  // trigger's click-to-pin + Escape. CSS handles the hover/focus reveal. Both are sticky pins now —
  // opening one closes the other overlays (onOpen), and a scene click leaves a pin untouched.
  const abortController = new AbortController();
  const timeReveal = installReveal(timeWrap, timeChip, abortController.signal, () =>
    closeOverlaysExcept("time"),
  );
  const actionsReveal = installReveal(actionsWrap, chevron, abortController.signal, () =>
    closeOverlaysExcept("actions"),
  );
  overlayClosers.set("time", () => timeReveal.setExpanded(false));
  overlayClosers.set("actions", () => actionsReveal.setExpanded(false));

  // Responsive overflow — below a phone-width threshold the scrub can't share the bar with the
  // pickers, so it relocates into the chevron's action panel and the bar drops to its compact layout.
  // matchMedia keeps it declarative; both reveals close on each switch so nothing floats over the move.
  const compactQuery = doc.defaultView?.matchMedia("(max-width: 560px)") ?? null;
  const applyCompact = (isCompact: boolean): void => {
    container.classList.toggle("is-compact", isCompact);
    timeReveal.setExpanded(false);
    actionsReveal.setExpanded(false);
    if (isCompact) actions.appendChild(timeWrap);
    else container.insertBefore(timeWrap, projChip);
  };
  applyCompact(compactQuery?.matches ?? false);
  compactQuery?.addEventListener("change", (e) => applyCompact(e.matches), {
    signal: abortController.signal,
  });

  rebuildRange();

  const subscriptions = createSubscriptions();
  subscriptions.on(
    store,
    (s) => s.datasetId,
    () => {
      syncDatasetLabel();
      datasetPopover.refresh();
    },
  );
  subscriptions.on(store, (s) => s.dataset, syncDatasetLabel); // run metadata lands after the id switch
  subscriptions.on(store, (s) => s.projection, applyProjection);
  subscriptions.on(
    store,
    (s) => s.activeField,
    (name) => {
      fieldLabelEl.textContent = fieldButtonLabel(name);
      fieldPopover.refresh();
    },
  );
  subscriptions.on(
    store,
    (s) => s.availableFields,
    () => fieldPopover.refresh(),
  );
  subscriptions.on(store, (s) => s.availableSteps, rebuildRange);
  subscriptions.on(store, (s) => s.currentStep, syncCursor);
  installChromeVisibility(subscriptions, uiStore, (isVisible) => {
    container.hidden = !isVisible;
    if (!isVisible) {
      datasetPopover.close();
      fieldPopover.close();
      timeReveal.setExpanded(false); // don't restore a pinned reveal when the bar is shown again
      actionsReveal.setExpanded(false);
    }
  });

  return () => {
    subscriptions.dispose();
    abortController.abort();
    range?.dispose();
    datasetPopover.dispose();
    fieldPopover.dispose();
    container.remove();
  };
}
