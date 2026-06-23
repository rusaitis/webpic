// One shared, monotonically rising z-order for floating chrome — windows, the colorbar + its settings
// dialog, anything that should jump to the top when opened or clicked. Each raise grabs the next value
// off a single counter, so the most recently touched panel always sits above the rest. The band starts
// above docked chrome (≤14) and stays well below the fixed higher bands in styles.ts (so they win no
// matter how many raises happen): menu chrome + its panels — topbar, side rail, rail flyout — at ~800,
// the help modal at 1000, anchored control menus at 1100.

const Z_FLOATING_BASE = 15;
let zTop = Z_FLOATING_BASE;

/** Lift `el` above every other floating panel. */
export function bringToFront(el: HTMLElement): void {
  zTop += 1;
  el.style.zIndex = `${zTop}`;
}

/** Raise `el` on pointerdown (capture, so it wins before inner drag/click handlers). Returns a
 *  disposer; pass a `signal` instead to tie removal to an AbortController. */
export function installRaise(el: HTMLElement, signal?: AbortSignal): () => void {
  const onDown = (): void => bringToFront(el);
  const options: AddEventListenerOptions = { capture: true };
  if (signal) options.signal = signal;
  el.addEventListener("pointerdown", onDown, options);
  return () => el.removeEventListener("pointerdown", onDown, true);
}
