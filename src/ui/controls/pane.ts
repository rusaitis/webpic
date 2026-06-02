import { createCheckbox } from "./checkbox.ts";
import { makeEl } from "./dom.ts";
import { createSelect } from "./select.ts";
import { createSlider } from "./slider.ts";
import { createTextInput } from "./text.ts";
import type {
  ButtonHandle,
  ButtonOptions,
  CheckboxOptions,
  ControlHandle,
  Disposer,
  Folder,
  FolderOptions,
  Pane,
  SelectHandle,
  SelectOptions,
  SliderOptions,
  TextOptions,
  Widget,
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

function makeFolder(doc: Document, opts: FolderOptions): Folder {
  const element = makeEl(doc, "div", "webpic-folder");
  const bar = makeEl(doc, "button", "webpic-folder_bar");
  bar.type = "button";
  bar.textContent = opts.title;
  const body = makeEl(doc, "div", "webpic-folder_body");
  if (opts.expanded === false) body.hidden = true;
  const onBar = (): void => {
    body.hidden = !body.hidden;
  };
  bar.addEventListener("click", onBar);
  element.append(bar, body);

  // Each child registers a self-removing disposer; folder teardown runs a snapshot so a
  // disposer deleting itself mid-iteration can't skip a sibling.
  const disposers = new Set<Disposer>();
  const track = (dispose: Disposer): Disposer => {
    disposers.add(dispose);
    return dispose;
  };

  // Wrap a widget in a labeled row.
  function attach<T>(
    row: HTMLElement,
    valueCell: HTMLElement,
    widget: Widget<T>,
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
    addSelect<V extends string>(o: SelectOptions<V>): SelectHandle<V> {
      const { row, valueCell } = makeRow(doc, o.label);
      const widget = createSelect<V>(doc, o.value, o.options, o.onChange);
      return { ...attach(row, valueCell, widget), setOptions: (next) => widget.setOptions(next) };
    },
    addCheckbox(o: CheckboxOptions): ControlHandle<boolean> {
      const { row, valueCell } = makeRow(doc, o.label);
      return attach(row, valueCell, createCheckbox(doc, o.value, o.label, o.onChange));
    },
    addText(o: TextOptions): ControlHandle<string> {
      const { row, valueCell } = makeRow(doc, o.label);
      return attach(row, valueCell, createTextInput(doc, o.value, o.onChange));
    },
    addButton(o: ButtonOptions): ButtonHandle {
      const wrap = makeEl(doc, "div", "webpic-button");
      const button = makeEl(doc, "button", "webpic-button_btn");
      button.type = "button";
      button.textContent = o.label;
      button.disabled = o.disabled ?? false;
      wrap.appendChild(button);
      body.appendChild(wrap);
      const onClick = (): void => {
        if (!button.disabled) o.onClick();
      };
      button.addEventListener("click", onClick);
      const dispose = track(() => {
        button.removeEventListener("click", onClick);
        wrap.remove();
        disposers.delete(dispose);
      });
      return {
        element: wrap,
        setDisabled: (disabled) => {
          button.disabled = disabled;
        },
        dispose,
      };
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
    dispose() {
      for (const dispose of [...disposers]) dispose();
      bar.removeEventListener("click", onBar);
      element.remove();
    },
  };
}

export function createPane(opts: { parent: HTMLElement; title?: string }): Pane {
  const doc = opts.parent.ownerDocument;
  const element = makeEl(doc, "div", "webpic-pane");
  if (opts.title !== undefined) {
    const header = makeEl(doc, "div", "webpic-pane_title");
    header.textContent = opts.title;
    element.appendChild(header);
  }
  opts.parent.appendChild(element);

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
