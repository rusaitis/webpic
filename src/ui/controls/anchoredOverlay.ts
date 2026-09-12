import { installOutsideClickDismiss } from "./dom.ts";
import type { Disposer } from "./types.ts";

// The dismissal contract every transient surface anchored to a trigger owes the user: Escape closes
// it and returns focus, a press outside closes it, and a resize keeps it under its anchor. Each rail
// flyout, menu, card and popover used to answer two or three of those, and never the same two.
// `position` is omitted when CSS places the surface; `close` is the caller's, since some close by
// store intent and some by local state.
export interface AnchoredOverlayOptions {
  readonly overlay: HTMLElement;
  readonly trigger: HTMLElement;
  readonly isOpen: () => boolean;
  readonly close: () => void;
  readonly position?: () => void;
  // The coords card closes without stealing focus back — it is toggled by a shortcut as often as by
  // its button, and yanking focus to the rail mid-flight is worse than leaving it.
  readonly shouldRestoreFocus?: boolean;
  readonly signal?: AbortSignal;
}

export function installAnchoredOverlay(options: AnchoredOverlayOptions): Disposer {
  const doc = options.trigger.ownerDocument;
  const abortController = new AbortController();
  const signal =
    options.signal === undefined
      ? abortController.signal
      : AbortSignal.any([abortController.signal, options.signal]);

  doc.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !options.isOpen()) return;
      event.preventDefault();
      options.close();
      if (options.shouldRestoreFocus !== false) options.trigger.focus();
    },
    { signal },
  );

  const reposition = options.position;
  if (reposition !== undefined) {
    doc.defaultView?.addEventListener(
      "resize",
      () => {
        if (options.isOpen()) reposition();
      },
      { signal },
    );
  }

  installOutsideClickDismiss(doc, {
    overlay: options.overlay,
    trigger: options.trigger,
    isOpen: options.isOpen,
    onDismiss: options.close,
    signal,
  });

  return () => abortController.abort();
}
