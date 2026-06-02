import type { Widget } from "./types.ts";

// Sibling order matters: the `.webpic-checkbox_input:checked + .webpic-checkbox_box svg`
// rule toggles the checkmark, so the input must precede the box.

const SVG_NS = "http://www.w3.org/2000/svg";

export function createCheckbox(
  doc: Document,
  value: boolean,
  ariaLabel: string,
  onChange: (value: boolean) => void,
): Widget<boolean> {
  const label = doc.createElement("label");
  label.className = "webpic-checkbox";
  label.setAttribute("aria-label", ariaLabel);

  const input = doc.createElement("input");
  input.type = "checkbox";
  input.className = "webpic-checkbox_input";
  input.checked = value;

  const box = doc.createElement("div");
  box.className = "webpic-checkbox_box";
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2 8l4 4l8 -8");
  svg.appendChild(path);
  box.appendChild(svg);

  label.append(input, box);

  const ac = new AbortController();
  input.addEventListener("change", () => onChange(input.checked), { signal: ac.signal });

  return {
    element: label,
    set(next) {
      input.checked = next;
    },
    setDisabled(disabled) {
      input.disabled = disabled;
    },
    dispose() {
      ac.abort();
      label.remove();
    },
  };
}
