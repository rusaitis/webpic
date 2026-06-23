import { clamp } from "@schema/math.ts";
import type { SimulationStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import { bringToFront, installRaise } from "../floating/zStack.ts";
import { installColormapControls } from "./colormapControls.ts";

// The colorbar's settings popover: a small glass dialog hosting the colormap controls, anchored to
// the colorbar's gear and placed on the side facing the viewport center (so it never opens
// off-screen). Mirrors the left rail flyout's lifecycle — local open state, reposition on
// open/resize, Escape + outside-pointerdown to dismiss. Body-appended so it escapes the colorbar's
// overflow clip. Headerless: too small for a title bar, so the dialog's aria-label is its only name.

const GAP = 10; // px between the colorbar and the popover
const MARGIN = 8; // viewport keep-in margin

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

export function installColorbarSettings(opts: ColorbarSettingsOptions): ColorbarSettings {
  const doc = opts.parent.ownerDocument;
  const ac = new AbortController();
  const pop = makeEl(doc, "div", "webpic-cbar-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Colormap settings");
  pop.hidden = true;

  const body = makeEl(doc, "div", "webpic-cbar-pop_body");
  pop.append(body);
  opts.parent.appendChild(pop);
  installRaise(pop, ac.signal); // clicking the dialog keeps it above the floating windows

  const controlsDispose = installColormapControls(body, opts.store);

  let isOpen = false;

  const reposition = (): void => {
    const cb = opts.colorbar.getBoundingClientRect();
    const a = opts.anchor.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const edge = opts.colorbar.dataset.edge ?? "bottom";
    let left: number;
    let top: number;
    if (edge === "left") {
      left = cb.right + GAP;
      top = a.top + a.height / 2 - h / 2;
    } else if (edge === "right") {
      left = cb.left - GAP - w;
      top = a.top + a.height / 2 - h / 2;
    } else if (edge === "top") {
      top = cb.bottom + GAP;
      left = a.left + a.width / 2 - w / 2;
    } else {
      top = cb.top - GAP - h; // bottom edge → open upward
      left = a.left + a.width / 2 - w / 2;
    }
    left = clamp(left, MARGIN, Math.max(MARGIN, vw - w - MARGIN));
    top = clamp(top, MARGIN, Math.max(MARGIN, vh - h - MARGIN));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  };

  const setOpen = (next: boolean): void => {
    isOpen = next;
    pop.hidden = !next;
    opts.anchor.setAttribute("aria-expanded", String(next));
    if (next) {
      bringToFront(pop); // opening lifts it over any floating windows
      reposition(); // offsetWidth/Height are valid only once shown
    }
  };

  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && isOpen) {
      setOpen(false);
      opts.anchor.focus();
    }
  };
  const onDocPointerDown = (e: MouseEvent): void => {
    if (!isOpen) return;
    const target = e.target;
    if (target instanceof Node && (pop.contains(target) || opts.anchor.contains(target))) return;
    setOpen(false);
  };
  const onResize = (): void => {
    if (isOpen) reposition();
  };
  doc.addEventListener("keydown", onDocKeyDown, { signal: ac.signal });
  doc.addEventListener("mousedown", onDocPointerDown, { signal: ac.signal });
  doc.defaultView?.addEventListener("resize", onResize, { signal: ac.signal });

  return {
    toggle: () => setOpen(!isOpen),
    close: () => setOpen(false),
    isOpen: () => isOpen,
    reposition: () => {
      if (isOpen) reposition();
    },
    dispose() {
      ac.abort();
      controlsDispose();
      pop.remove();
    },
  };
}
