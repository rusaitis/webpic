// One shared, monotonically rising z-order for floating chrome — windows, the colorbar + its settings
// dialog, anything that should jump to the top when opened or clicked. Each raise grabs the next value
// off a single counter, so the most recently touched panel always sits above the rest. The band starts
// above docked chrome (≤14) and stays well below the fixed higher bands in styles.ts (so they win no
// matter how many raises happen): menu chrome + its panels — topbar, side rail, rail flyout — at ~800,
// the help modal at 1000, anchored control menus at 1100.
//
// Every stacked element installs a raiser, so once the last raiser releases nothing holds a z-index
// and the counter returns to the base — a full teardown (tests, embed dispose) leaves no drift behind.

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
  const ac = new AbortController();
  element.addEventListener("pointerdown", onDown, { capture: true, signal: ac.signal });
  raiserCount += 1;

  let isReleased = false;
  const release = (): void => {
    if (isReleased) return;
    isReleased = true;
    ac.abort();
    raiserCount -= 1;
    if (raiserCount === 0) zTop = Z_FLOATING_BASE;
  };
  signal?.addEventListener("abort", release, { once: true });
  return release;
}
