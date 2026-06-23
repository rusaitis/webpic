import { DATASET_CATALOG } from "@schema/datasets.ts";
import type { FieldName } from "@schema/types.ts";
import type { SimulationStore, UiStore } from "@store";
import { makeEl } from "./controls/dom.ts";
import { createPopover, type Disposer, type RangeValue } from "./controls/index.ts";
import { createRangeControl } from "./controls/rangeControl.ts";
import {
  datasetLabel,
  fieldButtonLabel,
  fieldMetaRows,
  stepAt,
  stepIndex,
  stepReadout,
} from "./topBarInfo.ts";

// The top menu bar (magviz's glass-pill topbar, rebuilt to webpic's structure): a brand, a dataset
// dropdown, a "content" button that opens the available fields + their metadata, a timestep chip that
// opens a scrub popover (the custom range control + prev/next) on click/tap, and a click-opened
// cluster of disabled placeholder actions behind a chevron — both reveals share one installReveal. On
// a narrow viewport (matchMedia) the bar goes compact: the timestep scrub relocates into the chevron's
// panel so the row still fits and the chevron never spills off-screen.
// ui → store only — every control reads a slice or dispatches a
// typed intent; no render import. It owns dataset/field/time now, so those docked panels drop from the
// default layout (schema/theme defaultPanels). Hides with the global UI toggle like ui/cameraRail,
// force-closing its popovers + reveal so neither floats over a hidden bar.

// 16×16 inline SVGs (no icon-font dep); `fill: none; stroke: currentColor` come from the bar CSS.
const BRAND_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 9.4c2.1-4.8 4.4-4.8 6.4 0"/><path d="M8 6.6c2 4.8 4.3 4.8 6.4 0"/></svg>`;
const CARET_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5 8 10l4-3.5"/></svg>`;
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

  const caret = (): HTMLSpanElement => {
    const span = makeEl(doc, "span", "webpic-topbar_caret");
    span.innerHTML = CARET_SVG;
    return span;
  };
  const iconButton = (control: string, icon: string, title: string): HTMLButtonElement => {
    const btn = makeEl(doc, "button", "webpic-topbar_btn webpic-topbar_icon");
    btn.type = "button";
    btn.dataset.control = control;
    btn.title = title;
    btn.innerHTML = icon;
    return btn;
  };
  // Compact, borderless step buttons (magviz's subtle scrubber) — distinct from the filled picker /
  // icon buttons; styled by .webpic-topbar_step-btn.
  const stepButton = (control: string, icon: string, title: string): HTMLButtonElement => {
    const btn = makeEl(doc, "button", "webpic-topbar_step-btn");
    btn.type = "button";
    btn.dataset.control = control;
    btn.title = title;
    btn.innerHTML = icon;
    return btn;
  };
  const pickerButton = (control: string, extra: string, title: string): HTMLButtonElement => {
    const btn = makeEl(doc, "button", `webpic-topbar_btn ${extra}`);
    btn.type = "button";
    btn.dataset.control = control;
    btn.title = title;
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    return btn;
  };

  // A click-to-open reveal: clicking the trigger toggles .is-expanded (CSS shows the popover only then
  // — no hover-open, matching the pickers), with Escape-to-close (returns focus to the trigger). A
  // pinned reveal is sticky — an outside scene click never dismisses it; only re-clicking the trigger,
  // Escape, or opening another overlay (onOpen → closeOverlaysExcept) closes it. Shared by the time
  // chip + the actions chevron.
  const installReveal = (
    wrapper: HTMLElement,
    trigger: HTMLButtonElement,
    ac: AbortController,
    onOpen?: () => void,
  ): { setExpanded: (on: boolean) => void; isExpanded: () => boolean } => {
    const isExpanded = (): boolean => wrapper.classList.contains("is-expanded");
    const setExpanded = (on: boolean): void => {
      wrapper.classList.toggle("is-expanded", on);
      trigger.setAttribute("aria-expanded", String(on));
      if (on) onOpen?.();
    };
    trigger.addEventListener("click", () => setExpanded(!isExpanded()), { signal: ac.signal });
    doc.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && isExpanded()) {
          setExpanded(false);
          trigger.focus();
        }
      },
      { signal: ac.signal },
    );
    return { setExpanded, isExpanded };
  };

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

  // Dataset picker — switches the built-in dataset; labels come from the static schema catalog.
  const datasetBtn = pickerButton("dataset", "webpic-topbar_dataset", "Dataset");
  const datasetLabelEl = makeEl(doc, "span", "webpic-topbar_label");
  datasetLabelEl.textContent = datasetLabel(store.getState().datasetId);
  datasetBtn.append(datasetLabelEl, caret());

  const datasetItems = DATASET_CATALOG.map((d) => ({ value: d.id, label: d.label }));
  const datasetPopover = createPopover<{ value: string; label: string }>({
    anchor: datasetBtn,
    dismissOnOutside: false,
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
  const fieldBtn = pickerButton("field", "webpic-topbar_field", "Dataset contents");
  const fieldLabelEl = makeEl(doc, "span", "webpic-topbar_label");
  fieldLabelEl.textContent = fieldButtonLabel(store.getState().activeField);
  fieldBtn.append(fieldLabelEl, caret());

  // The active field always appears, even if it isn't in the computed set yet (mirrors fieldPanel).
  const fieldItems = (): { value: FieldName }[] => {
    const { availableFields, activeField } = store.getState();
    const names = availableFields.includes(activeField)
      ? availableFields
      : [activeField, ...availableFields];
    return names.map((name) => ({ value: name }));
  };
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
    dismissOnOutside: false,
    onOpen: () => closeOverlaysExcept("field"),
    getItems: fieldItems,
    getSelected: () => store.getState().activeField,
    onSelect: (name) => void store.getState().selectField(name),
    renderRow: (rowDoc, item) => renderFieldRow(rowDoc, item.value),
  });
  overlayClosers.set("field", () => fieldPopover.close());

  // Time control — a compact "step N" chip that reveals a scrub popover (track + prev/next) on
  // hover/tap, so the resting bar stays a single centered line. The custom range control bakes
  // min/max/step at construction, so a changed domain rebuilds it (mirrors ui/panels/timePanel); a
  // cursor move reflects via set() without echo. Disabled (≤1 step) dims the chip + gates it shut.
  const timeWrap = makeEl(doc, "div", "webpic-topbar_time webpic-topbar_reveal");
  const timeChip = makeEl(doc, "button", "webpic-topbar_chip");
  timeChip.type = "button";
  timeChip.dataset.control = "time";
  timeChip.title = "Timestep";
  timeChip.setAttribute("aria-haspopup", "true");
  timeChip.setAttribute("aria-expanded", "false");
  const stepLabelEl = makeEl(doc, "span", "webpic-topbar_step");
  timeChip.append(stepLabelEl, caret());

  const timePop = makeEl(doc, "div", "webpic-topbar_pop webpic-topbar_time-pop");
  const prevBtn = stepButton("step-prev", ICON.prev, "Previous step");
  const nextBtn = stepButton("step-next", ICON.next, "Next step");
  timePop.append(prevBtn, nextBtn); // the scrub track is inserted between them by rebuildRange
  timeWrap.append(timeChip, timePop);

  let range: ReturnType<typeof createRangeControl> | null = null;
  let steps: readonly number[] = []; // the availableSteps snapshot the live control was built against

  const dispatchIndex = (index: number): void => {
    const step = stepAt(index, steps);
    if (step !== undefined) store.getState().setStep(step); // self-guards out-of-domain + no-ops
  };
  // The grip is a focusable <div role="slider">, not an <input>, so bare-key shortcuts (F/C) reach the
  // document handlers while it's focused — unlike the old native slider. Matches timePanel's scrub.
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

  // Hover-revealed actions — a chevron at the right edge opens a popover of (inert until their
  // milestones land) action buttons. Same reveal mechanism + glass-card (.webpic-topbar_pop) as the
  // time chip. The popover is absolute, so it never widens the bar.
  const actionsWrap = makeEl(doc, "div", "webpic-topbar_reveal");
  const chevron = iconButton("more", CARET_SVG, "More actions");
  chevron.classList.add("webpic-topbar_chevron");
  chevron.setAttribute("aria-haspopup", "true");
  chevron.setAttribute("aria-expanded", "false");
  const actions = makeEl(doc, "div", "webpic-topbar_pop webpic-topbar_actions");
  const actionsGrid = makeEl(doc, "div", "webpic-topbar_actions-grid");
  const placeholder = (control: string, icon: string, title: string): HTMLButtonElement => {
    const btn = iconButton(control, icon, `${title} (coming soon)`);
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    return btn;
  };
  actionsGrid.append(
    placeholder("upload", ICON.upload, "Upload data"),
    placeholder("layers", ICON.layers, "Layers"),
    placeholder("export", ICON.export, "Export view"),
    placeholder("layout", ICON.layout, "Compare / layout"),
  );
  actions.append(actionsGrid); // the compact bar appends the relocated time scrub below this grid
  actionsWrap.append(chevron, actions);

  container.append(brand, datasetBtn, fieldBtn, timeWrap, actionsWrap);
  parent.appendChild(container);

  // Both reveals share one AbortController (torn down by ac.abort()); installReveal wires each
  // trigger's click-to-pin + Escape. CSS handles the hover/focus reveal. Both are sticky pins now —
  // opening one closes the other overlays (onOpen), and a scene click leaves a pin untouched.
  const ac = new AbortController();
  const timeReveal = installReveal(timeWrap, timeChip, ac, () => closeOverlaysExcept("time"));
  const actionsReveal = installReveal(actionsWrap, chevron, ac, () =>
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
    else container.insertBefore(timeWrap, actionsWrap);
  };
  applyCompact(compactQuery?.matches ?? false);
  compactQuery?.addEventListener("change", (e) => applyCompact(e.matches), { signal: ac.signal });

  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (!visible) {
      datasetPopover.close();
      fieldPopover.close();
      timeReveal.setExpanded(false); // don't restore a pinned reveal when the bar is shown again
      actionsReveal.setExpanded(false);
    }
  };

  rebuildRange();
  applyVisible(uiStore.getState().isUiVisible);

  const unsubs = [
    store.subscribe(
      (s) => s.datasetId,
      (id) => {
        datasetLabelEl.textContent = datasetLabel(id);
        datasetPopover.refresh();
      },
    ),
    store.subscribe(
      (s) => s.activeField,
      (name) => {
        fieldLabelEl.textContent = fieldButtonLabel(name);
        fieldPopover.refresh();
      },
    ),
    store.subscribe(
      (s) => s.availableFields,
      () => fieldPopover.refresh(),
    ),
    store.subscribe((s) => s.availableSteps, rebuildRange),
    store.subscribe((s) => s.currentStep, syncCursor),
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
    ac.abort();
    range?.dispose();
    datasetPopover.dispose();
    fieldPopover.dispose();
    container.remove();
  };
}
