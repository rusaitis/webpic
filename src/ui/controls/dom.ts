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
  opts: { title?: string; control?: string; ariaLabel?: string } = {},
): HTMLButtonElement {
  const button = makeEl(doc, "button", className);
  button.type = "button";
  if (opts.control !== undefined) button.dataset.control = opts.control;
  if (opts.title !== undefined) button.title = opts.title;
  if (opts.ariaLabel !== undefined) button.setAttribute("aria-label", opts.ariaLabel);
  button.innerHTML = svg;
  return button;
}
