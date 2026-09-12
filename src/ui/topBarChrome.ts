import { makeCaret, makeEl, makeIconButton } from "./controls/dom.ts";
import { ICON_CARET_FLAT } from "./icons.ts";

// The top bar's element vocabulary — the three button shapes it uses and the click-to-open reveal
// two of its chips share. Split out so installTopBar reads as what the bar contains rather than how
// each piece is assembled; nothing here touches the store.

export function makeTopBarCaret(doc: Document): HTMLSpanElement {
  return makeCaret(doc, "webpic-topbar_caret", ICON_CARET_FLAT);
}

export function makeTopBarIconButton(
  doc: Document,
  control: string,
  icon: string,
  title: string,
): HTMLButtonElement {
  return makeIconButton(doc, "webpic-topbar_btn webpic-topbar_icon", icon, { control, title });
}

// Compact and borderless — distinct from the filled picker / icon buttons.
export function makeStepButton(
  doc: Document,
  control: string,
  icon: string,
  title: string,
): HTMLButtonElement {
  return makeIconButton(doc, "webpic-topbar_step-btn", icon, { control, title });
}

export function makePickerButton(
  doc: Document,
  control: string,
  extra: string,
  title: string,
): HTMLButtonElement {
  const button = makeEl(doc, "button", `webpic-topbar_btn ${extra}`);
  button.type = "button";
  button.dataset.control = control;
  button.title = title;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  return button;
}

export interface Reveal {
  setExpanded(on: boolean): void;
  isExpanded(): boolean;
}

// A click-to-open reveal: clicking the trigger toggles .is-expanded (CSS shows the popover only then
// — no hover-open, matching the pickers), with Escape-to-close that returns focus to the trigger. A
// pinned reveal is sticky: an outside scene click never dismisses it; only re-clicking the trigger,
// Escape, or opening another overlay (via `onOpen`) closes it.
export function installReveal(
  wrapper: HTMLElement,
  trigger: HTMLButtonElement,
  signal: AbortSignal,
  onOpen?: () => void,
): Reveal {
  const doc = wrapper.ownerDocument;
  const isExpanded = (): boolean => wrapper.classList.contains("is-expanded");
  const setExpanded = (on: boolean): void => {
    wrapper.classList.toggle("is-expanded", on);
    trigger.setAttribute("aria-expanded", String(on));
    if (on) onOpen?.();
  };
  trigger.addEventListener("click", () => setExpanded(!isExpanded()), { signal });
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && isExpanded()) {
        setExpanded(false);
        trigger.focus();
      }
    },
    { signal },
  );
  return { setExpanded, isExpanded };
}
