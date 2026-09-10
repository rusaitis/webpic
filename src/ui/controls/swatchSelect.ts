import { ICON_CARET } from "../icons.ts";
import { makeCaret, makeEl } from "./dom.ts";
import { createPopover } from "./popover.ts";
import type { SelectOption, SelectWidget } from "./types.ts";

// A select whose trigger and rows show a painted swatch instead of plain text — the colormap picker.
// Reuses createPopover for the list shell (lazy build, reposition, Esc / outside-click / arrow nav,
// per-row check) and takes `paintSwatch` injected, so this control has no colormap dependency. The
// trigger is a <button> because createPopover anchors to one. Conforms to SelectWidget so the facade
// wraps it exactly like a native select.

const TRIGGER_W = 120;
const ROW_W = 180;
const SWATCH_H = 14;

export function createSwatchSelect<V extends string>(
  doc: Document,
  value: V,
  options: ReadonlyArray<SelectOption<V>>,
  onChange: (value: V) => void,
  paintSwatch: (canvas: HTMLCanvasElement, value: V) => void,
): SelectWidget<V> {
  let labels = new Map(options.map((o) => [o.value, o.label]));
  let items: ReadonlyArray<SelectOption<V>> = options;
  let current = value;

  const button = makeEl(doc, "button", "webpic-swatch");
  button.type = "button";
  const canvas = makeEl(doc, "canvas", "webpic-swatch_canvas");
  canvas.width = TRIGGER_W;
  canvas.height = SWATCH_H;
  const name = makeEl(doc, "span", "webpic-swatch_name");
  const caret = makeCaret(doc, "webpic-swatch_caret", ICON_CARET);
  button.append(canvas, name, caret);

  const reflectTrigger = (): void => {
    button.dataset.value = current;
    name.textContent = labels.get(current) ?? current;
    paintSwatch(canvas, current);
  };
  reflectTrigger();

  const popover = createPopover<SelectOption<V>>({
    anchor: button,
    getItems: () => items,
    getSelected: () => current,
    onSelect: (v) => {
      // The popover reports a plain string; the row list is the V-typed source, so recover V there.
      const hit = items.find((o) => o.value === v);
      if (hit !== undefined) onChange(hit.value);
    },
    className: "is-swatches",
    renderRow: (rowDoc, item) => {
      const wrap = makeEl(rowDoc, "div", "webpic-popover_swatch");
      const rowCanvas = makeEl(rowDoc, "canvas", "webpic-swatch_canvas");
      rowCanvas.width = ROW_W;
      rowCanvas.height = SWATCH_H;
      paintSwatch(rowCanvas, item.value);
      const rowName = makeEl(rowDoc, "span", "webpic-swatch_name");
      rowName.textContent = item.label;
      wrap.append(rowCanvas, rowName);
      return wrap;
    },
  });

  return {
    element: button,
    set(next) {
      current = next;
      reflectTrigger();
      popover.refresh(); // re-tick the active row if the list is open
    },
    setOptions(next) {
      items = next;
      labels = new Map(next.map((o) => [o.value, o.label]));
      reflectTrigger();
      popover.refresh();
    },
    setDisabled(disabled) {
      button.disabled = disabled;
      if (disabled) popover.close();
    },
    dispose() {
      popover.dispose();
      button.remove();
    },
  };
}
