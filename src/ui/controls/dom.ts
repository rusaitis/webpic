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
  const button = makeEl(doc, "button", `webpic-icon ${className}`);
  button.type = "button";
  if (options.control !== undefined) button.dataset.control = options.control;
  if (options.title !== undefined) button.title = options.title;
  if (options.ariaLabel !== undefined) button.setAttribute("aria-label", options.ariaLabel);
  button.innerHTML = svg;
  return button;
}

// The panel close (×). Its three hosts — floating window, rail flyout, layers panel — were three
// identical buttons under three BEM names; the class is the contract, so they share one.
export function makeCloseButton(doc: Document, svg: string): HTMLButtonElement {
  return makeIconButton(doc, "webpic-close-btn", svg, { ariaLabel: "Close" });
}

// A panel's title bar: an uppercase label and the close button, in the lifted strip above the body.
// The rail flyout and the layers panel are the same header under two BEM names; the class is the
// contract, so they share one.
export function makePanelHeader(
  doc: Document,
  titleText: string,
  closeIcon: string,
): { header: HTMLDivElement; closeBtn: HTMLButtonElement } {
  const header = makeEl(doc, "div", "webpic-panel_header");
  const title = makeEl(doc, "span", "webpic-panel_title");
  title.textContent = titleText;
  const closeBtn = makeCloseButton(doc, closeIcon);
  header.append(title, closeBtn);
  return { header, closeBtn };
}

// The dropdown-affordance caret/chevron: a <span> carrying a constant inline SVG, trailing the
// topbar pickers/chips and the swatch trigger. Class + icon vary per host; the SVG is a trusted
// module constant (same innerHTML-of-trusted-markup contract as makeIconButton).
export function makeCaret(doc: Document, className: string, svg: string): HTMLSpanElement {
  const span = makeEl(doc, "span", `webpic-icon ${className}`);
  span.innerHTML = svg;
  return span;
}

// A press on one of these is the control's, not the surface's: it must not start a drag on the
// floating chrome or toggle the colorbar's collapse. One list, so the two cannot disagree about
// which elements count (they already did — one copy had dropped `textarea`).
const INTERACTIVE_SELECTOR = "button, input, select, textarea, a, [data-no-drag]";

export function isInteractiveTarget(event: Event): boolean {
  const { target } = event;
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

// Dismiss a transient overlay when a press lands outside both it and its trigger — every rail
// flyout, menu, card and popover in the layer. Each keeps its own Escape binding (the key handling
// differs). `isOpen` is read live, so a caller may install once for its lifetime; one that only
// listens while open passes its open-scoped `signal` instead. The press event is the caller's:
// the popover wants capture-phase `pointerdown` (it must win the press), the rails `mousedown`.
export function installOutsideClickDismiss(
  doc: Document,
  options: {
    overlay: HTMLElement;
    trigger: HTMLElement;
    isOpen: () => boolean;
    onDismiss: () => void;
    eventName?: "mousedown" | "pointerdown";
    isCapturing?: boolean;
    signal?: AbortSignal;
  },
): Disposer {
  const onPress = (event: Event): void => {
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
  const abortController = new AbortController();
  const signal =
    options.signal === undefined
      ? abortController.signal
      : AbortSignal.any([abortController.signal, options.signal]);
  doc.addEventListener(options.eventName ?? "mousedown", onPress, {
    signal,
    capture: options.isCapturing ?? false,
  });
  return () => abortController.abort();
}
