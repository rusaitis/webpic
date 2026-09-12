// One shared, monotonically rising z-order for floating chrome — windows, the colorbar, its settings
// dialog. Each raise takes the next value off a single counter, so the most recently touched panel
// sits above the rest. The band starts above docked chrome (≤14) and stays below the fixed bands in
// styles.ts, which must win regardless of how many raises happen: menu chrome ~800, help modal 1000,
// anchored control menus 1100. Every stacked element installs a raiser, so once the last one releases
// the counter returns to base and a full teardown leaves no drift behind.

export const Z_FLOATING_BASE = 15;
let zTop = Z_FLOATING_BASE;
let raiserCount = 0;

// Lift `element` above every other floating panel.
export function bringToFront(element: HTMLElement): void {
  zTop += 1;
  element.style.zIndex = `${zTop}`;
}

// Raise `element` on pointerdown (capture, so it wins before inner drag/click handlers). Returns a
// disposer; pass a `signal` instead to tie removal to an AbortController. Either release path is
// idempotent — the raiser is counted out exactly once.
export function installRaise(element: HTMLElement, signal?: AbortSignal): () => void {
  if (signal?.aborted) return () => {};
  const onDown = (): void => bringToFront(element);
  // One internal controller behind both release paths: the listener comes off exactly once whether
  // the caller's signal aborts or the returned disposer runs.
  const abortController = new AbortController();
  element.addEventListener("pointerdown", onDown, {
    capture: true,
    signal: abortController.signal,
  });
  raiserCount += 1;

  let isReleased = false;
  const release = (): void => {
    if (isReleased) return;
    isReleased = true;
    abortController.abort();
    raiserCount -= 1;
    if (raiserCount === 0) zTop = Z_FLOATING_BASE;
  };
  signal?.addEventListener("abort", release, { once: true });
  return release;
}
