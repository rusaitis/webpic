import { clamp } from "@schema/math.ts";
import type { SimulationStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import { installColormapControls } from "./colormapControls.ts";

// The colorbar's settings popover: a glass dialog hosting the colormap controls, anchored to the
// colorbar's gear and placed on the side facing the viewport center (so it never opens off-screen).
// Mirrors the left rail flyout's lifecycle — local open state, reposition on open/resize, Escape +
// outside-pointerdown to dismiss. Body-appended so it escapes the colorbar's overflow clip.

const GAP = 10; // px between the colorbar and the popover
const MARGIN = 8; // viewport keep-in margin

const CLOSE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

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
  const pop = makeEl(doc, "div", "webpic-cbar-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Colormap settings");
  pop.hidden = true;

  const header = makeEl(doc, "div", "webpic-cbar-pop_header");
  const title = makeEl(doc, "span", "webpic-cbar-pop_title");
  title.textContent = "Colormap";
  const closeBtn = makeEl(doc, "button", "webpic-cbar-pop_close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = CLOSE_ICON;
  header.append(title, closeBtn);

  const body = makeEl(doc, "div", "webpic-cbar-pop_body");
  pop.append(header, body);
  opts.parent.appendChild(pop);

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
    if (next) reposition(); // offsetWidth/Height are valid only once shown
  };

  closeBtn.addEventListener("click", () => {
    setOpen(false);
    opts.anchor.focus();
  });

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
  doc.addEventListener("keydown", onDocKeyDown);
  doc.addEventListener("mousedown", onDocPointerDown);
  doc.defaultView?.addEventListener("resize", onResize);

  return {
    toggle: () => setOpen(!isOpen),
    close: () => setOpen(false),
    isOpen: () => isOpen,
    reposition: () => {
      if (isOpen) reposition();
    },
    dispose() {
      doc.removeEventListener("keydown", onDocKeyDown);
      doc.removeEventListener("mousedown", onDocPointerDown);
      doc.defaultView?.removeEventListener("resize", onResize);
      controlsDispose();
      pop.remove();
    },
  };
}
