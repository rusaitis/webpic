import { makeEl, makeIconButton } from "../controls/dom.ts";
import { ICON_CLOSE } from "../icons.ts";
import { installCornerResize } from "./cornerResize.ts";
import { installDragSnap } from "./dragSnap.ts";
import { bringToFront, installRaise } from "./zStack.ts";

// A reusable floating window: a draggable (grip in the header), resizable (corner handle) glass panel
// that other webpic features mount content into. Free-drag (clamp to viewport, no edge docking) via
// dragSnap's "free" mode, plus a bottom-right corner-resize grip; it raises to the front on
// pointerdown so stacked windows order naturally. create*() → a handle you drive (show/hide/setTitle/
// dispose); the host wires content + visibility. The colorbar is the edge-snapping cousin — this is
// the movable-window template.

const DEFAULT_WIDTH_PX = 240;
const DEFAULT_HEIGHT_PX = 180;
const DEFAULT_MIN_WIDTH_PX = 200;
const DEFAULT_MIN_HEIGHT_PX = 140;
const DEFAULT_TOP_PX = 64; // clear of the top bar
const DEFAULT_RIGHT_PX = 16;

interface FloatingWindowInitial {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}

export interface FloatingWindowOptions {
  readonly parent: HTMLElement;
  readonly title: string;
  readonly width?: number;
  readonly height?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
  // First-paint inset; defaults to top-right (top 64, right 16). Reflow then anchors top-left.
  readonly initial?: FloatingWindowInitial;
  // When set, a close (×) button is rendered in the header and calls this on click. The consumer
  // owns the effect — hide (`handle.hide()`), dispose, or a store intent.
  readonly onClose?: () => void;
}

export interface FloatingWindowHandle {
  readonly element: HTMLElement;
  // The content host — mount a pane/controls here.
  readonly body: HTMLElement;
  setTitle(title: string): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

export function createFloatingWindow(options: FloatingWindowOptions): FloatingWindowHandle {
  const doc = options.parent.ownerDocument;
  const abortController = new AbortController();

  const container = makeEl(doc, "div", "webpic-window");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", options.title);
  container.style.width = `${options.width ?? DEFAULT_WIDTH_PX}px`;
  container.style.height = `${options.height ?? DEFAULT_HEIGHT_PX}px`;

  // Header: grip dots (the drag affordance) + title + an actions slot (e.g. the close button); the
  // whole bar is the drag handle, so the slot is marked no-drag.
  const bar = makeEl(doc, "div", "webpic-window_bar");
  const grip = makeEl(doc, "span", "webpic-window_grip");
  grip.setAttribute("aria-hidden", "true");
  const title = makeEl(doc, "span", "webpic-window_title");
  title.textContent = options.title;
  const actions = makeEl(doc, "div", "webpic-window_actions");
  actions.dataset.noDrag = "";
  if (options.onClose !== undefined) {
    const closeBtn = makeIconButton(doc, "webpic-window_close", ICON_CLOSE, { ariaLabel: "Close" });
    closeBtn.addEventListener("click", () => options.onClose?.(), {
      signal: abortController.signal,
    });
    actions.append(closeBtn);
  }
  bar.append(grip, title, actions);

  const body = makeEl(doc, "div", "webpic-window_body");

  const resize = makeEl(doc, "div", "webpic-window_resize");
  resize.dataset.noDrag = "";
  resize.setAttribute("aria-hidden", "true");

  container.append(bar, body, resize);

  // Initial inline placement (top-right by default); the mount-time reflow rewrites it to a top-left
  // anchor so corner-resize keeps the top-left fixed.
  const initial = options.initial ?? {};
  container.style.top = `${initial.top ?? DEFAULT_TOP_PX}px`;
  if (initial.left !== undefined) container.style.left = `${initial.left}px`;
  else container.style.right = `${initial.right ?? DEFAULT_RIGHT_PX}px`;
  if (initial.bottom !== undefined) container.style.bottom = `${initial.bottom}px`;

  options.parent.appendChild(container);

  bringToFront(container); // newest window opens on top of the shared floating stack
  installRaise(container, abortController.signal); // and re-raises whenever it's grabbed

  const drag = installDragSnap(container, { mode: "free", handle: bar });
  const disposeResize = installCornerResize(container, resize, {
    minWidth: options.minWidth ?? DEFAULT_MIN_WIDTH_PX,
    minHeight: options.minHeight ?? DEFAULT_MIN_HEIGHT_PX,
  });

  // Settle the top-left anchor once layout (and thus rects) are valid.
  doc.defaultView?.requestAnimationFrame(() => drag.reflow());

  return {
    element: container,
    body,
    setTitle(next) {
      title.textContent = next;
      container.setAttribute("aria-label", next);
    },
    show() {
      container.hidden = false;
      // Settle the anchor now the window is laid out — a window created hidden (e.g. the per-layer
      // settings, default-closed) skipped its creation-time reflow (0×0 rect), so do it on first show.
      doc.defaultView?.requestAnimationFrame(() => drag.reflow());
    },
    hide() {
      container.hidden = true;
    },
    dispose() {
      abortController.abort();
      disposeResize();
      drag.dispose();
      container.remove();
    },
  };
}
