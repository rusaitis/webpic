import { clamp } from "@schema/math.ts";
import { installOutsideClickDismiss, makeEl } from "./controls/dom.ts";
import { ICON_PLUS } from "./layerIcons.ts";
import { positionArrowFlyout } from "./layout.ts";

// A rail add-button's click-to-open menu (DESIGN §UI "create and navigate from one seam"): lists the
// existing instances of one layer kind as quick-jumps, then an "Add new". Not the single-select
// createPopover — its listbox/check-column semantics are wrong for an action list where "Add new"
// isn't a value. A flyout-style panel beside the anchor (tail on the button center), built off
// anchor.ownerDocument (happy-dom + embed safe).

export interface RailMenuItem {
  readonly id: string;
  readonly label: string;
}

export interface RailMenuOptions {
  readonly anchor: HTMLButtonElement; // the +Kind rail button
  readonly parent: HTMLElement; // the rail's fixed-position host (the menu mounts here)
  readonly title: string; // e.g. "Volume layers"
  readonly getItems: () => readonly RailMenuItem[]; // existing instances of this kind
  readonly getSelected: () => string | null; // selectedLayerId, marks the active row
  readonly onPick: (id: string) => void; // jump to an instance (then the menu closes)
  readonly onAddNew: () => void; // create a new instance (then the menu closes)
}

export interface RailMenuHandle {
  refresh(): void; // rebuild rows if open (the layer list changed)
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

export function installRailMenu(options: RailMenuOptions): RailMenuHandle {
  const { anchor, parent } = options;
  const doc = parent.ownerDocument;
  const abortController = new AbortController();
  const { signal } = abortController;

  const panel = makeEl(doc, "div", "webpic-railmenu");
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", options.title);
  panel.hidden = true;
  const arrow = makeEl(doc, "div", "webpic-railmenu_arrow");
  const heading = makeEl(doc, "div", "webpic-railmenu_title");
  heading.textContent = options.title;
  const list = makeEl(doc, "div", "webpic-railmenu_list");
  panel.append(arrow, heading, list);
  parent.appendChild(panel);

  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "false");

  let isOpen = false;
  let items: HTMLButtonElement[] = []; // focusable rows in DOM order (instances, then "Add new")

  const focusItem = (index: number): void => {
    const next = items[clamp(index, 0, items.length - 1)];
    next?.focus();
  };
  // indexOf compares identity only, so a non-row (or null) activeElement safely yields −1
  const focusedIndex = (): number => items.indexOf(doc.activeElement as HTMLButtonElement);

  const build = (): void => {
    list.replaceChildren();
    items = [];
    const selected = options.getSelected();
    for (const item of options.getItems()) {
      const row = makeEl(doc, "button", "webpic-railmenu_item");
      row.type = "button";
      row.setAttribute("role", "menuitem");
      const active = item.id === selected;
      if (active) row.classList.add("is-active");
      const dot = makeEl(doc, "span", "webpic-railmenu_dot");
      const label = makeEl(doc, "span", "webpic-railmenu_label");
      label.textContent = item.label;
      row.append(dot, label);
      row.addEventListener("click", () => {
        options.onPick(item.id);
        close();
      });
      list.appendChild(row);
      items.push(row);
    }
    if (items.length > 0) list.appendChild(makeEl(doc, "div", "webpic-railmenu_sep"));
    const add = makeEl(doc, "button", "webpic-railmenu_add");
    add.type = "button";
    add.setAttribute("role", "menuitem");
    const plus = makeEl(doc, "span", "webpic-railmenu_plus");
    plus.innerHTML = ICON_PLUS;
    const addLabel = makeEl(doc, "span", "webpic-railmenu_label");
    addLabel.textContent = "Add new";
    add.append(plus, addLabel);
    add.addEventListener("click", () => {
      options.onAddNew();
      close();
    });
    list.appendChild(add);
    items.push(add);
  };

  const position = (): void => {
    const btn = anchor.getBoundingClientRect();
    positionArrowFlyout(panel, btn, btn, doc);
  };

  function open(): void {
    if (isOpen) return;
    build();
    panel.hidden = false;
    isOpen = true;
    anchor.setAttribute("aria-expanded", "true");
    position();
    focusItem(0);
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    list.replaceChildren();
    items = [];
    anchor.setAttribute("aria-expanded", "false");
  }

  anchor.addEventListener(
    "click",
    () => {
      if (isOpen) close();
      else open();
    },
    { signal },
  );

  // Roving focus among the real buttons (Enter/Space activate natively); Esc closes + restores anchor.
  panel.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          close();
          anchor.focus();
          break;
        case "ArrowDown":
          event.preventDefault();
          focusItem(focusedIndex() + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          focusItem(focusedIndex() - 1);
          break;
        case "Home":
          event.preventDefault();
          focusItem(0);
          break;
        case "End":
          event.preventDefault();
          focusItem(items.length - 1);
          break;
        default:
          break;
      }
    },
    { signal },
  );

  doc.defaultView?.addEventListener(
    "resize",
    () => {
      if (isOpen) position();
    },
    { signal },
  );

  const disposeOutside = installOutsideClickDismiss(doc, {
    overlay: panel,
    trigger: anchor,
    isOpen: () => isOpen,
    onDismiss: () => close(),
  });

  return {
    refresh: () => {
      if (isOpen) {
        build();
        position();
      }
    },
    close,
    isOpen: () => isOpen,
    dispose: () => {
      abortController.abort();
      disposeOutside();
      panel.remove();
    },
  };
}
