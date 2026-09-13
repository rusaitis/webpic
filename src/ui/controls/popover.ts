import { ICON_CHECK } from "../icons.ts";
import { installOutsideClickDismiss, makeEl } from "./dom.ts";

// A lightweight anchored single-select popover (the dataset + content pickers in ui/topbar/bar share it).
// Content-agnostic: the caller supplies each row's body via renderRow, so one interaction shell —
// lazy build on open, reposition on scroll/resize, optional outside-pointerdown + Esc + arrow-key nav, focus
// return to the trigger — serves both a plain dataset list and a rich field-metadata list. Built off
// the anchor's ownerDocument (never the global document), so it's happy-dom-testable and embed-safe.
// Single-select only; multi-select can follow when multi-field datasets arrive.

export interface PopoverItem<V extends string = string> {
  readonly value: V;
}

export interface PopoverOptions<T extends PopoverItem> {
  readonly anchor: HTMLButtonElement; // the trigger; popover sits under it, focus returns here on Esc
  readonly getItems: () => readonly T[]; // re-read on every open + refresh()
  readonly getSelected: () => string | null; // current value, for the tick + active seed
  readonly onSelect: (value: string) => void; // commit (then the popover closes)
  readonly renderRow: (doc: Document, item: T, selected: boolean) => HTMLElement; // the row's content
  readonly className?: string; // extra class on the popover root (e.g. "is-fields")
  readonly onOpen?: () => void; // fired after the panel opens (lets callers close sibling overlays)
  readonly shouldDismissOnOutside?: boolean; // outside pointerdown closes it (default true; false → sticky)
}

export interface PopoverHandle {
  open(): void;
  close(): void;
  toggle(): void;
  refresh(): void; // rebuild rows if open (the data changed)
  isOpen(): boolean;
  dispose(): void; // close + drop every listener + remove the popover node
}

const MIN_WIDTH_PX = 200;
const GAP_PX = 6;

export function createPopover<T extends PopoverItem>(options: PopoverOptions<T>): PopoverHandle {
  const { anchor } = options;
  const doc = anchor.ownerDocument;
  const win = doc.defaultView;
  const shouldDismissOnOutside = options.shouldDismissOnOutside ?? true;

  let panel: HTMLElement | null = null; // the listbox; built lazily on first open
  let rows: HTMLElement[] = []; // option elements, parallel to `items`
  let items: readonly T[] = [];
  let activeIndex = -1;
  let isVisible = false;
  // The document/window listeners live for one open-cycle, so they get a controller per open rather
  // than four paired add/remove calls whose capture flags have to match.
  let openAbort: AbortController | undefined;

  const ensurePanel = (): HTMLElement => {
    if (panel !== null) return panel;
    const element = makeEl(
      doc,
      "div",
      options.className ? `webpic-popover ${options.className}` : "webpic-popover",
    );
    element.setAttribute("role", "listbox");
    element.tabIndex = -1;
    element.hidden = true;
    doc.body.appendChild(element);
    panel = element;
    return element;
  };

  const setActive = (index: number): void => {
    if (index === activeIndex) return;
    rows[activeIndex]?.classList.remove("is-active");
    activeIndex = index;
    const row = rows[activeIndex];
    if (row !== undefined) {
      row.classList.add("is-active");
      row.scrollIntoView({ block: "nearest" });
    }
  };

  const commit = (index: number): void => {
    const item = items[index];
    if (item === undefined) return;
    options.onSelect(item.value);
    close(); // the trigger label updates via the caller's store subscription
  };

  const buildRows = (): void => {
    const element = ensurePanel();
    element.replaceChildren();
    rows = [];
    items = options.getItems();
    const selected = options.getSelected();
    items.forEach((item, index) => {
      const isSelected = item.value === selected;
      const row = makeEl(doc, "div", "webpic-popover_item");
      row.setAttribute("role", "option");
      row.dataset.value = item.value;
      row.setAttribute("aria-selected", String(isSelected));
      const check = makeEl(doc, "span", "webpic-popover_check");
      check.innerHTML = ICON_CHECK;
      row.append(check, options.renderRow(doc, item, isSelected));
      row.addEventListener("mouseenter", () => setActive(index));
      row.addEventListener("click", (event) => {
        event.preventDefault();
        commit(index);
      });
      element.appendChild(row);
      rows.push(row);
    });
    // Seed the active option at the current selection (else the first row).
    activeIndex = -1;
    const sel = items.findIndex((item) => item.value === selected);
    setActive(sel >= 0 ? sel : 0);
  };

  const reposition = (): void => {
    if (panel === null) return;
    const rect = anchor.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.bottom + GAP_PX}px`;
    panel.style.minWidth = `${Math.max(rect.width, MIN_WIDTH_PX)}px`;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isVisible) return;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        anchor.focus(); // keyboard dismissal returns focus to the trigger; outside-click does not
        break;
      case "ArrowDown":
        event.preventDefault();
        setActive(Math.min(activeIndex + 1, rows.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive(Math.max(activeIndex - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(rows.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      default:
        break;
    }
  };

  function open(): void {
    if (isVisible) return;
    const element = ensurePanel();
    buildRows();
    element.hidden = false;
    isVisible = true;
    anchor.setAttribute("aria-expanded", "true");
    reposition();
    openAbort = new AbortController();
    const { signal } = openAbort;
    if (shouldDismissOnOutside) {
      installOutsideClickDismiss(doc, {
        overlay: element,
        trigger: anchor,
        isOpen: () => isVisible,
        onDismiss: close,
        eventName: "pointerdown",
        isCapturing: true,
        signal,
      });
    }
    doc.addEventListener("keydown", onKeyDown, { signal });
    win?.addEventListener("resize", reposition, { signal });
    win?.addEventListener("scroll", reposition, { capture: true, signal });
    options.onOpen?.();
  }

  function close(): void {
    if (!isVisible) return;
    isVisible = false;
    if (panel !== null) {
      panel.hidden = true;
      panel.replaceChildren();
    }
    rows = [];
    activeIndex = -1;
    anchor.setAttribute("aria-expanded", "false");
    openAbort?.abort();
    openAbort = undefined;
  }

  const toggle = (): void => {
    if (isVisible) close();
    else open();
  };

  const onAnchorClick = (): void => toggle();
  const onAnchorKeyDown = (event: KeyboardEvent): void => {
    if (isVisible) return; // the doc-level handler owns navigation while open
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  // Lifetime anchor listeners (the open/close doc listeners above are toggled per-open instead).
  const anchorAbort = new AbortController();
  anchor.addEventListener("click", onAnchorClick, { signal: anchorAbort.signal });
  anchor.addEventListener("keydown", onAnchorKeyDown, { signal: anchorAbort.signal });

  return {
    open,
    close,
    toggle,
    isOpen: () => isVisible,
    refresh: () => {
      if (isVisible) buildRows();
    },
    dispose: () => {
      close();
      anchorAbort.abort();
      panel?.remove();
      panel = null;
    },
  };
}
