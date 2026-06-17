import { DATASET_CATALOG } from "@schema/datasets.ts";
import type { FieldName } from "@schema/types.ts";
import type { SimulationStore, UiStore } from "@store";
import { makeEl } from "./controls/dom.ts";
import { createPopover, type Disposer } from "./controls/index.ts";
import {
  datasetLabel,
  fieldButtonLabel,
  fieldMetaRows,
  stepAt,
  stepIndex,
  stepReadout,
} from "./topBarInfo.ts";

// The top menu bar (magviz's topbar, rebuilt to webpic's structure): a brand, a dataset dropdown, a
// "content" button that opens the available fields + their metadata, a timestep slider flanked by
// prev/next, and a cluster of disabled placeholder actions. ui → store only — every control reads a
// slice or dispatches a typed intent; no render import. It owns dataset/field/time now, so those
// docked panels drop from the default layout (schema/theme defaultPanels). Hides with the global UI
// toggle like ui/cameraRail, force-closing its popovers so neither floats over a hidden bar.

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
  const pickerButton = (control: string, extra: string, title: string): HTMLButtonElement => {
    const btn = makeEl(doc, "button", `webpic-topbar_btn ${extra}`);
    btn.type = "button";
    btn.dataset.control = control;
    btn.title = title;
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    return btn;
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
    getItems: () => datasetItems,
    getSelected: () => store.getState().datasetId,
    onSelect: (id) => store.getState().selectDataset(id),
    renderRow: (rowDoc, item) => {
      const span = makeEl(rowDoc, "span", "webpic-popover_text");
      span.textContent = item.label;
      return span;
    },
  });

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
    getItems: fieldItems,
    getSelected: () => store.getState().activeField,
    onSelect: (name) => void store.getState().selectField(name),
    renderRow: (rowDoc, item) => renderFieldRow(rowDoc, item.value),
  });

  // Time control — a scrub slider over the discrete step domain (indices, not raw values), flanked by
  // single-step prev/next. All three disabled when there's nothing to scrub (≤1 step).
  const timeWrap = makeEl(doc, "div", "webpic-topbar_time");
  const prevBtn = iconButton("step-prev", ICON.prev, "Previous step");
  const nextBtn = iconButton("step-next", ICON.next, "Next step");
  const slider = makeEl(doc, "input", "webpic-topbar_slider");
  slider.type = "range";
  slider.min = "0";
  slider.step = "1";
  slider.setAttribute("aria-label", "Time step");
  const stepLabelEl = makeEl(doc, "span", "webpic-topbar_step");
  timeWrap.append(prevBtn, slider, nextBtn, stepLabelEl);

  const dispatchIndex = (index: number): void => {
    const steps = store.getState().availableSteps;
    const step = stepAt(index, steps);
    if (step !== undefined) store.getState().setStep(step); // self-guards out-of-domain + no-ops
  };
  const stepBy = (delta: number): void => {
    const { currentStep, availableSteps } = store.getState();
    dispatchIndex(stepIndex(currentStep, availableSteps) + delta);
  };
  slider.addEventListener("input", () => {
    stepLabelEl.textContent = stepReadout(Number(slider.value), store.getState().availableSteps);
    dispatchIndex(Number(slider.value));
  });
  prevBtn.addEventListener("click", () => stepBy(-1));
  nextBtn.addEventListener("click", () => stepBy(1));

  // Reflects the step domain + cursor onto the slider; set-in never echoes (we only dispatch on input).
  const syncSlider = (): void => {
    const { availableSteps, currentStep } = store.getState();
    const disabled = availableSteps.length <= 1;
    slider.max = String(Math.max(0, availableSteps.length - 1));
    slider.value = String(stepIndex(currentStep, availableSteps));
    slider.disabled = disabled;
    prevBtn.disabled = disabled;
    nextBtn.disabled = disabled;
    timeWrap.classList.toggle("is-disabled", disabled);
    stepLabelEl.textContent = stepReadout(Number(slider.value), availableSteps);
  };

  // Placeholder actions — visible but inert until their milestones land (no listeners; `disabled`).
  const actions = makeEl(doc, "div", "webpic-topbar_actions");
  const placeholder = (control: string, icon: string, title: string): HTMLButtonElement => {
    const btn = iconButton(control, icon, `${title} (coming soon)`);
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    return btn;
  };
  actions.append(
    placeholder("upload", ICON.upload, "Upload data"),
    placeholder("layers", ICON.layers, "Layers"),
    placeholder("export", ICON.export, "Export view"),
    placeholder("layout", ICON.layout, "Compare / layout"),
  );

  const spacer = makeEl(doc, "div", "webpic-topbar_spacer");
  container.append(brand, datasetBtn, fieldBtn, timeWrap, spacer, actions);
  parent.appendChild(container);

  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (!visible) {
      datasetPopover.close();
      fieldPopover.close();
    }
  };

  syncSlider();
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
    store.subscribe((s) => s.availableSteps, syncSlider),
    store.subscribe((s) => s.currentStep, syncSlider),
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
    datasetPopover.dispose();
    fieldPopover.dispose();
    container.remove();
  };
}
