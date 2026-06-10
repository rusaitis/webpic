// Shared guard for bare-key shortcuts: typing surfaces must keep their keystrokes. Covers the
// form controls plus contenteditable hosts (which instanceof checks miss).
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
