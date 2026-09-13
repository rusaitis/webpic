import type { SimulationStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import { installAnchoredOverlay } from "../floating/anchoredOverlay.ts";
import { bringToFront, installRaise } from "../floating/zStack.ts";
import { clampIntoViewport, POPOVER_GAP_PX } from "../layout.ts";
import { installColormapControls } from "./colormapControls.ts";

// The colorbar's settings popover: a small glass dialog hosting the colormap controls, anchored to
// the colorbar's gear and placed on the side facing the viewport center (so it never opens
// off-screen). Mirrors the left rail flyout's lifecycle — local open state, reposition on
// open/resize, Escape + outside-pointerdown to dismiss. Body-appended so it escapes the colorbar's
// overflow clip. Headerless: too small for a title bar, so the dialog's aria-label is its only name.

export interface ColorbarSettings {
  toggle(): void;
  close(): void;
  isOpen(): boolean;
  reposition(): void;
  dispose(): void;
}

export interface ColorbarSettingsOptions {
  readonly parent: HTMLElement;
  readonly anchor: HTMLElement; // the gear button
  readonly colorbar: HTMLElement; // for edge-aware placement
  readonly store: SimulationStore;
}

export function installColorbarSettings(options: ColorbarSettingsOptions): ColorbarSettings {
  const doc = options.parent.ownerDocument;
  const abortController = new AbortController();
  const pop = makeEl(doc, "div", "webpic-cbar-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Colormap settings");
  pop.hidden = true;

  const body = makeEl(doc, "div", "webpic-cbar-pop_body");
  pop.append(body);
  options.parent.appendChild(pop);
  installRaise(pop, abortController.signal); // clicking the dialog keeps it above the floating windows

  const controlsDispose = installColormapControls(body, options.store);

  let isOpen = false;

  const reposition = (): void => {
    const colorbarRect = options.colorbar.getBoundingClientRect();
    const a = options.anchor.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const edge = options.colorbar.dataset.edge ?? "bottom";
    let left: number;
    let top: number;
    if (edge === "left") {
      left = colorbarRect.right + POPOVER_GAP_PX;
      top = a.top + a.height / 2 - h / 2;
    } else if (edge === "right") {
      left = colorbarRect.left - POPOVER_GAP_PX - w;
      top = a.top + a.height / 2 - h / 2;
    } else if (edge === "top") {
      top = colorbarRect.bottom + POPOVER_GAP_PX;
      left = a.left + a.width / 2 - w / 2;
    } else {
      top = colorbarRect.top - POPOVER_GAP_PX - h; // bottom edge → open upward
      left = a.left + a.width / 2 - w / 2;
    }
    const placed = clampIntoViewport({ left, top, width: w, height: h }, { width: vw, height: vh });
    pop.style.left = `${Math.round(placed.left)}px`;
    pop.style.top = `${Math.round(placed.top)}px`;
  };

  const setOpen = (next: boolean): void => {
    isOpen = next;
    pop.hidden = !next;
    options.anchor.setAttribute("aria-expanded", String(next));
    if (next) {
      bringToFront(pop); // opening lifts it over any floating windows
      reposition(); // offsetWidth/Height are valid only once shown
    }
  };

  installAnchoredOverlay({
    overlay: pop,
    trigger: options.anchor,
    isOpen: () => isOpen,
    close: () => setOpen(false),
    position: reposition,
    signal: abortController.signal,
  });

  return {
    toggle: () => setOpen(!isOpen),
    close: () => setOpen(false),
    isOpen: () => isOpen,
    reposition: () => {
      if (isOpen) reposition();
    },
    dispose() {
      abortController.abort();
      controlsDispose();
      pop.remove();
    },
  };
}
