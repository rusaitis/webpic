import type { UiStore } from "@store";
import { makeEl } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";
import { createSubscriptions } from "./subscriptions.ts";

// Bottom-center status pill (spinner + message) driven by the ui store's loadingPhases /
// statusError facts. All timing policy lives here: a show delay so cached/fast ops never
// flash it, a min-visible window so it never blinks, and an error auto-clear. It stays up
// while the global UI is hidden — it's status, not chrome. On install it adopts the
// index.html boot splash (same geometry, pre-painted) for a seamless HTML→JS handoff.

export const STATUS_SHOW_DELAY_MS = 200;
export const STATUS_MIN_VISIBLE_MS = 300;
export const STATUS_ERROR_VISIBLE_MS = 2500;

export function installStatusPill(parent: HTMLElement, uiStore: UiStore): Disposer {
  const doc = parent.ownerDocument;
  const container = makeEl(doc, "div", "webpic-status");
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  const spinner = makeEl(doc, "span", "webpic-status_spinner");
  const text = makeEl(doc, "span", "webpic-status_text");
  container.append(spinner, text);

  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let isShown = false;
  let shownAt = 0;

  const show = (): void => {
    container.classList.add("is-visible");
    isShown = true;
    shownAt = Date.now();
  };
  const hide = (): void => {
    container.classList.remove("is-visible");
    isShown = false;
  };
  const cancelShow = (): void => {
    clearTimeout(showTimer);
    showTimer = undefined;
  };
  const cancelHide = (): void => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  };

  const render = (): void => {
    const { loadingPhases, statusError } = uiStore.getState();

    if (statusError !== null) {
      // Errors skip the show delay and own the text until auto-clear; a repeat flash
      // (fresh object identity in the store) lands here again and restarts the timer.
      cancelShow();
      cancelHide();
      container.dataset.kind = "error";
      if (text.textContent !== statusError.message) text.textContent = statusError.message;
      if (!isShown) show();
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => uiStore.getState().clearError(), STATUS_ERROR_VISIBLE_MS);
      return;
    }
    delete container.dataset.kind;

    // Oldest active phase owns the text: it progresses monotonically as phases drain
    // (boot keeps "webpic" through the splash handoff even when a later-begun dataset
    // open completes first — newest-wins flashed A→B→A there).
    const current = loadingPhases[0];
    if (current !== undefined) {
      if (text.textContent !== current.message) text.textContent = current.message;
      cancelHide();
      if (!isShown && showTimer === undefined) {
        showTimer = setTimeout(() => {
          showTimer = undefined;
          show();
        }, STATUS_SHOW_DELAY_MS);
      }
    } else {
      cancelShow();
      if (isShown && hideTimer === undefined) {
        const remaining = Math.max(0, STATUS_MIN_VISIBLE_MS - (Date.now() - shownAt));
        hideTimer = setTimeout(() => {
          hideTimer = undefined;
          hide();
        }, remaining);
      }
    }
  };

  // Adopt the boot splash: it pre-painted the identical pill from raw HTML, so when work
  // is already in flight the JS pill appears pre-shown (class set before insertion — no
  // entrance transition) and the swap is pixel-stable.
  doc.getElementById("splash")?.remove();
  const initial = uiStore.getState();
  if (initial.loadingPhases.length > 0 || initial.statusError !== null) {
    show();
  }
  render();
  parent.appendChild(container);

  const subscriptions = createSubscriptions();
  subscriptions.on(uiStore, (s) => s.loadingPhases, render);
  subscriptions.on(uiStore, (s) => s.statusError, render);

  return () => {
    subscriptions.dispose();
    cancelShow();
    cancelHide();
    clearTimeout(errorTimer);
    container.remove();
  };
}
