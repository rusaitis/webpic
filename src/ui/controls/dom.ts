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
