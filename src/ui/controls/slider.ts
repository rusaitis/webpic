import { makeEl } from "./dom.ts";
import type { Widget } from "./types.ts";

// Basic linear slider (native range + readout); a richer log/symlog/interval RangeControl
// can slot in behind the same facade API without touching panels.

export function createSlider(
  doc: Document,
  value: number,
  min: number,
  max: number,
  step: number | undefined,
  format: ((value: number) => string) | undefined,
  onChange: (value: number) => void,
): Widget<number> {
  const wrap = makeEl(doc, "div", "webpic-slider");
  const input = makeEl(doc, "input", "webpic-slider_input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  if (step !== undefined) input.step = String(step);
  input.value = String(value);

  const readout = makeEl(doc, "span", "webpic-slider_readout");
  const fmt = format ?? ((v: number): string => String(v));
  readout.textContent = fmt(value);
  wrap.append(input, readout);

  const ac = new AbortController();
  const handleInput = (): void => {
    const next = input.valueAsNumber;
    readout.textContent = fmt(next);
    onChange(next);
  };
  input.addEventListener("input", handleInput, { signal: ac.signal });

  return {
    element: wrap,
    set(next) {
      input.value = String(next);
      readout.textContent = fmt(next);
    },
    setDisabled(disabled) {
      input.disabled = disabled;
    },
    dispose() {
      ac.abort();
      wrap.remove();
    },
  };
}
