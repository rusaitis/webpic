import { makeEl } from "./dom.ts";
import type { SelectChoice, SelectHandle } from "./types.ts";

// Native `<select>` — accessible, zero custom-popover surface.

export function createSelect<V extends string>(
  doc: Document,
  value: V,
  options: ReadonlyArray<SelectChoice<V>>,
  onChange: (value: V) => void,
): SelectHandle<V> {
  const select = makeEl(doc, "select", "webpic-select");

  const renderOptions = (next: ReadonlyArray<SelectChoice<V>>): void => {
    select.replaceChildren();
    for (const option of next) {
      const node = doc.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
  };
  renderOptions(options);
  select.value = value;

  const abortController = new AbortController();
  // Safe: `select` only ever holds the V-typed option values appended above.
  select.addEventListener("change", () => onChange(select.value as V), {
    signal: abortController.signal,
  });

  return {
    element: select,
    set(next) {
      select.value = next;
    },
    setOptions(next) {
      // Keep the current value if it survives the rebuild; otherwise leave the natural
      // first-option default (forcing a missing value would blank the select). The owner
      // re-`set`s the authoritative value afterward.
      const prev = select.value;
      renderOptions(next);
      if (next.some((option) => option.value === prev)) select.value = prev;
    },
    setDisabled(disabled) {
      select.disabled = disabled;
    },
    dispose() {
      abortController.abort();
      select.remove();
    },
  };
}
