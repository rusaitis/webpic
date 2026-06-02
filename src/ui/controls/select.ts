import type { SelectOption, SelectWidget } from "./types.ts";

// Native `<select>` — accessible, zero custom-popover surface.

export function createSelect<V extends string>(
  doc: Document,
  value: V,
  options: ReadonlyArray<SelectOption<V>>,
  onChange: (value: V) => void,
): SelectWidget<V> {
  const select = doc.createElement("select");
  select.className = "webpic-select";

  const renderOptions = (next: ReadonlyArray<SelectOption<V>>): void => {
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

  const ac = new AbortController();
  // Safe: `select` only ever holds the V-typed option values appended above.
  select.addEventListener("change", () => onChange(select.value as V), { signal: ac.signal });

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
      ac.abort();
      select.remove();
    },
  };
}
