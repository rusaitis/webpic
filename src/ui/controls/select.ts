import type { SelectOption, Widget } from "./types.ts";

// Native `<select>` — accessible, zero custom-popover surface.

export function createSelect<V extends string>(
  doc: Document,
  value: V,
  options: ReadonlyArray<SelectOption<V>>,
  onChange: (value: V) => void,
): Widget<V> {
  const select = doc.createElement("select");
  select.className = "webpic-select";
  for (const option of options) {
    const node = doc.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.value = value;

  // Safe: `select` only ever holds the V-typed option values appended above.
  const handleChange = (): void => onChange(select.value as V);
  select.addEventListener("change", handleChange);

  return {
    element: select,
    set(next) {
      select.value = next;
    },
    setDisabled(disabled) {
      select.disabled = disabled;
    },
    dispose() {
      select.removeEventListener("change", handleChange);
      select.remove();
    },
  };
}
