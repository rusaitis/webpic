import type { Disposer } from "./types.ts";

// Create elements off an explicit `Document` (the row's `ownerDocument`) rather than
// a global `document`, so the facade is testable under happy-dom and safe inside an
// embed iframe with its own document.

export function makeEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  element.className = className;
  return element;
}

// The icon-button idiom shared across the rails, topbar, popover, and floating chrome: a typed
// <button> carrying a constant inline SVG. `ariaLabel` is separate from `title` so a label-only
// button (rail/window close, colorbar gear) gets no stray tooltip. The SVG is a trusted module
// constant — no user data — so innerHTML bypasses no sanitization.
export function makeIconButton(
  doc: Document,
  className: string,
  svg: string,
  options: { title?: string; control?: string; ariaLabel?: string } = {},
): HTMLButtonElement {
  const button = makeEl(doc, "button", className);
  button.type = "button";
  if (options.control !== undefined) button.dataset.control = options.control;
  if (options.title !== undefined) button.title = options.title;
  if (options.ariaLabel !== undefined) button.setAttribute("aria-label", options.ariaLabel);
  button.innerHTML = svg;
  return button;
}

// The dropdown-affordance caret/chevron: a <span> carrying a constant inline SVG, trailing the
// topbar pickers/chips and the swatch trigger. Class + icon vary per host; the SVG is a trusted
// module constant (same innerHTML-of-trusted-markup contract as makeIconButton).
export function makeCaret(doc: Document, className: string, svg: string): HTMLSpanElement {
  const span = makeEl(doc, "span", className);
  span.innerHTML = svg;
  return span;
}

// Dismiss a transient overlay when a press lands outside both it and its trigger. The side-rail
// flyout and the bottom-rail coords card share this exact shape; each keeps its own Escape binding
// (the key handling differs). `isOpen` is read live so the listener stays installed for the
// component's lifetime. Returns a disposer.
export function installOutsideClickDismiss(
  doc: Document,
  options: {
    overlay: HTMLElement;
    trigger: HTMLElement;
    isOpen: () => boolean;
    onDismiss: () => void;
  },
): Disposer {
  const onDown = (event: MouseEvent): void => {
    if (!options.isOpen()) return;
    const target = event.target;
    if (
      target instanceof Node &&
      (options.overlay.contains(target) || options.trigger.contains(target))
    ) {
      return;
    }
    options.onDismiss();
  };
  const ac = new AbortController();
  doc.addEventListener("mousedown", onDown, { signal: ac.signal });
  return () => ac.abort();
}
