import { createCheckbox } from "./checkbox.ts";
import { makeEl } from "./dom.ts";
import { createRangeControl } from "./rangeControl.ts";
import { createSegmented } from "./segmented.ts";
import { createSelect } from "./select.ts";
import { createSlider } from "./slider.ts";
import { createSwatchSelect } from "./swatchSelect.ts";
import type {
  CheckboxOptions,
  ControlHandle,
  Disposer,
  Folder,
  FolderOptions,
  NoteHandle,
  Pane,
  RangeControlOptions,
  RangeValue,
  SegmentedOptions,
  SelectHandle,
  SelectOptions,
  SliderOptions,
  SwatchSelectOptions,
} from "./types.ts";

// Dependency-free Pane/Folder: callback-based add* (no two-way binding, no `typeof value`
// sniffing), DOM built off `ownerDocument`. Structure:
//   .webpic-pane > .webpic-folder > .webpic-folder_bar + .webpic-folder_body
//                                     > .webpic-row > .webpic-row_label + _value

function makeRow(doc: Document, label: string): { row: HTMLElement; valueCell: HTMLElement } {
  const row = makeEl(doc, "div", "webpic-row");
  const labelCell = makeEl(doc, "div", "webpic-row_label");
  labelCell.textContent = label;
  const valueCell = makeEl(doc, "div", "webpic-row_value");
  row.append(labelCell, valueCell);
  return { row, valueCell };
}

function makeFolder(doc: Document, options: FolderOptions): Folder {
  const element = makeEl(doc, "div", "webpic-folder");
  const bar = makeEl(doc, "button", "webpic-folder_bar");
  bar.type = "button";
  bar.textContent = options.title;
  const body = makeEl(doc, "div", "webpic-folder_body");
  const abortController = new AbortController();
  const onBar = (): void => {
    body.hidden = !body.hidden;
  };
  bar.addEventListener("click", onBar, { signal: abortController.signal });
  element.append(bar, body);

  // Each child registers a self-removing disposer; folder teardown runs a snapshot so a
  // disposer deleting itself mid-iteration can't skip a sibling.
  const disposers = new Set<Disposer>();
  const track = (dispose: Disposer): Disposer => {
    disposers.add(dispose);
    return dispose;
  };

  // Re-root a built control into a labeled row: the returned handle's `element` is the row.
  function attach<T>(
    row: HTMLElement,
    valueCell: HTMLElement,
    widget: ControlHandle<T>,
  ): ControlHandle<T> {
    valueCell.appendChild(widget.element);
    body.appendChild(row);
    const dispose = track(() => {
      widget.dispose();
      row.remove();
      disposers.delete(dispose);
    });
    return {
      element: row,
      set: (value) => widget.set(value),
      setDisabled: (disabled) => widget.setDisabled(disabled),
      dispose,
    };
  }

  // A SelectHandle is a ControlHandle plus setOptions; attach() handles the handle half, this
  // forwards setOptions — so both select variants come back the same shape from one place.
  function attachSelectable<V extends string>(
    row: HTMLElement,
    valueCell: HTMLElement,
    widget: SelectHandle<V>,
  ): SelectHandle<V> {
    return { ...attach(row, valueCell, widget), setOptions: (next) => widget.setOptions(next) };
  }

  return {
    element,
    addSlider(o: SliderOptions): ControlHandle<number> {
      const { row, valueCell } = makeRow(doc, o.label);
      return attach(
        row,
        valueCell,
        createSlider(doc, o.value, o.min, o.max, o.step, o.format, o.onChange),
      );
    },
    addRangeControl(o: RangeControlOptions): ControlHandle<RangeValue> {
      // `o` carries `label` (handled by makeRow); createRangeControl ignores it structurally.
      const { row, valueCell } = makeRow(doc, o.label);
      return attach(row, valueCell, createRangeControl(doc, o));
    },
    addSelect<V extends string>(o: SelectOptions<V>): SelectHandle<V> {
      const { row, valueCell } = makeRow(doc, o.label);
      return attachSelectable(row, valueCell, createSelect<V>(doc, o.value, o.options, o.onChange));
    },
    addSwatchSelect<V extends string>(o: SwatchSelectOptions<V>): SelectHandle<V> {
      const { row, valueCell } = makeRow(doc, o.label);
      return attachSelectable(
        row,
        valueCell,
        createSwatchSelect<V>(doc, o.value, o.options, o.onChange, o.paintSwatch),
      );
    },
    addSegmented<V extends string>(o: SegmentedOptions<V>): ControlHandle<V> {
      const { row, valueCell } = makeRow(doc, o.label);
      return attach(row, valueCell, createSegmented<V>(doc, o.value, o.options, o.onChange));
    },
    addCheckbox(o: CheckboxOptions): ControlHandle<boolean> {
      const { row, valueCell } = makeRow(doc, o.label);
      return attach(row, valueCell, createCheckbox(doc, o.value, o.label, o.onChange));
    },
    addFolder(o: FolderOptions): Folder {
      const sub = makeFolder(doc, o);
      body.appendChild(sub.element);
      const dispose = track(() => {
        sub.dispose();
        disposers.delete(dispose);
      });
      return { ...sub, dispose };
    },
    addNote(text: string): NoteHandle {
      const note = makeEl(doc, "div", "webpic-placeholder");
      note.textContent = text;
      body.appendChild(note);
      const dispose = track(() => {
        note.remove();
        disposers.delete(dispose);
      });
      return { element: note, dispose };
    },
    dispose() {
      for (const dispose of [...disposers]) dispose();
      abortController.abort();
      element.remove();
    },
  };
}

export function createPane(options: { parent: HTMLElement; title?: string }): Pane {
  const doc = options.parent.ownerDocument;
  const element = makeEl(doc, "div", "webpic-pane");
  if (options.title !== undefined) {
    const header = makeEl(doc, "div", "webpic-pane_title");
    header.textContent = options.title;
    element.appendChild(header);
  }
  options.parent.appendChild(element);

  const folders: Folder[] = [];
  return {
    element,
    addFolder(o: FolderOptions): Folder {
      const folder = makeFolder(doc, o);
      element.appendChild(folder.element);
      folders.push(folder);
      return folder;
    },
    dispose() {
      for (const folder of folders.slice()) folder.dispose();
      folders.length = 0;
      element.remove();
    },
  };
}
