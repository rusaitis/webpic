import { makeEl } from "./dom.ts";
import type { ControlHandle, SelectChoice } from "./types.ts";

// A sliding-pill segmented control: N equal-width radio buttons with one highlight pill that slides
// to the active segment. Pure-CSS motion — the pill position is a `--seg-index` custom property the
// stylesheet turns into a translateX, so there are no layout reads (happy-dom safe) and it tracks
// any container width. Same callback-out/set-in contract as the other controls.

export function createSegmented<V extends string>(
  doc: Document,
  value: V,
  options: ReadonlyArray<SelectChoice<V>>,
  onChange: (value: V) => void,
): ControlHandle<V> {
  const root = makeEl(doc, "div", "webpic-segmented");
  root.setAttribute("role", "radiogroup");
  root.style.setProperty("--seg-count", String(options.length));

  const pill = makeEl(doc, "div", "webpic-segmented_pill");
  root.appendChild(pill);

  const buttons: HTMLButtonElement[] = [];
  let current = value;

  const indexOf = (v: V): number => options.findIndex((o) => o.value === v);

  const reflect = (next: V): void => {
    current = next;
    const i = Math.max(0, indexOf(next));
    root.style.setProperty("--seg-index", String(i));
    buttons.forEach((button, j) => {
      button.setAttribute("aria-checked", String(j === i));
    });
  };

  const ac = new AbortController();
  options.forEach((option) => {
    const button = makeEl(doc, "button", "webpic-segmented_seg");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.dataset.value = option.value;
    button.textContent = option.label;
    button.addEventListener(
      "click",
      () => {
        if (option.value === current) return;
        reflect(option.value);
        onChange(option.value);
      },
      { signal: ac.signal },
    );
    root.appendChild(button);
    buttons.push(button);
  });

  // Arrow keys move within the group (radiogroup convention), committing as they go.
  root.addEventListener(
    "keydown",
    (event) => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      const next = options[(indexOf(current) + delta + options.length) % options.length];
      if (next === undefined || next.value === current) return;
      reflect(next.value);
      buttons[indexOf(next.value)]?.focus();
      onChange(next.value);
    },
    { signal: ac.signal },
  );

  reflect(value);

  return {
    element: root,
    set(next) {
      reflect(next);
    },
    setDisabled(disabled) {
      root.classList.toggle("is-disabled", disabled);
      for (const button of buttons) button.disabled = disabled;
    },
    dispose() {
      ac.abort();
      root.remove();
    },
  };
}
