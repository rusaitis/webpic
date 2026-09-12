import { makeEl } from "./dom.ts";
import type { ControlHandle } from "./types.ts";

export function createTextInput(
  doc: Document,
  value: string,
  onChange: (value: string) => void,
): ControlHandle<string> {
  const input = makeEl(doc, "input", "webpic-text");
  input.type = "text";
  input.spellcheck = false;
  input.value = value;

  const ac = new AbortController();
  input.addEventListener("change", () => onChange(input.value), { signal: ac.signal });

  return {
    element: input,
    set(next) {
      // Don't clobber what the user is typing; the store value re-syncs on blur.
      if (input.ownerDocument.activeElement !== input) input.value = next;
    },
    setDisabled(disabled) {
      input.disabled = disabled;
    },
    dispose() {
      ac.abort();
      input.remove();
    },
  };
}
