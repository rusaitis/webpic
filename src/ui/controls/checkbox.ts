import { makeEl } from "./dom.ts";
import type { ControlHandle } from "./types.ts";

// Sibling order matters: the `.webpic-checkbox_input:checked + .webpic-checkbox_box svg`
// rule toggles the checkmark, so the input must precede the box.

const SVG_NS = "http://www.w3.org/2000/svg";

export function createCheckbox(
  doc: Document,
  value: boolean,
  ariaLabel: string,
  onChange: (value: boolean) => void,
): ControlHandle<boolean> {
  const label = makeEl(doc, "label", "webpic-checkbox");
  label.setAttribute("aria-label", ariaLabel);

  const input = makeEl(doc, "input", "webpic-checkbox_input");
  input.type = "checkbox";
  input.checked = value;

  const box = makeEl(doc, "div", "webpic-checkbox_box");
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2 8l4 4l8 -8");
  svg.appendChild(path);
  box.appendChild(svg);

  label.append(input, box);

  const abortController = new AbortController();
  input.addEventListener("change", () => onChange(input.checked), {
    signal: abortController.signal,
  });

  return {
    element: label,
    set(next) {
      input.checked = next;
    },
    setDisabled(disabled) {
      input.disabled = disabled;
    },
    dispose() {
      abortController.abort();
      label.remove();
    },
  };
}
