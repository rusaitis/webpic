import { createRangeControl } from "./rangeControl.ts";
import type { RangeValue, Widget } from "./types.ts";

// Single-value linear slider: the same RangeControl primitive as the Window/Step sliders (track,
// grip, coupled text field), narrowed to the number-in/number-out facade panels bind against.

export function createSlider(
  doc: Document,
  value: number,
  min: number,
  max: number,
  step: number | undefined,
  format: ((value: number) => string) | undefined,
  onChange: (value: number) => void,
): Widget<number> {
  // Live emit on both edit paths (drag/keys via onInput, text/release via onChange), deduped so
  // the release commit of an unchanged value doesn't double-fire the panel callback.
  let last = value;
  const emit = (v: RangeValue): void => {
    if (typeof v === "number" && v !== last) {
      last = v;
      onChange(v);
    }
  };
  const inner = createRangeControl(doc, {
    min,
    max,
    value,
    ...(step !== undefined ? { step } : {}),
    ...(format !== undefined ? { format } : {}),
    onInput: emit,
    onChange: emit,
  });
  return {
    element: inner.element,
    set(next) {
      last = next;
      inner.set(next);
    },
    setDisabled(disabled) {
      inner.setDisabled(disabled);
    },
    dispose() {
      inner.dispose();
    },
  };
}
