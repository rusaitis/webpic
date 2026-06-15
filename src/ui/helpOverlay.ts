import type { UiStore } from "@store";
import { makeEl } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";
import { isTypingTarget } from "./keyboard.ts";
import { SHORTCUTS } from "./shortcuts.ts";

// Keyboard cheat-sheet: a centered modal toggled with `?` (Shift+/) or `H`, Escape or a backdrop
// click to close. install*() => Disposer. Visibility rides the ui store's help flag so a future
// header "?" button shares one source of truth. Nothing else documents the bindings, so this is
// the discovery surface for the new roll / fly-through / axis-snap keys.
export function installHelpOverlay(parent: HTMLElement, uiStore: UiStore): Disposer {
  const doc = parent.ownerDocument;
  const overlay = makeEl(doc, "div", "webpic-help");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Keyboard shortcuts");
  overlay.setAttribute("aria-modal", "true");

  const panel = makeEl(doc, "div", "webpic-help_panel");
  const title = makeEl(doc, "div", "webpic-help_title");
  title.textContent = "Keyboard shortcuts";
  panel.appendChild(title);

  const grid = makeEl(doc, "div", "webpic-help_grid");
  for (const section of SHORTCUTS) {
    const col = makeEl(doc, "div", "webpic-help_section");
    const sectionTitle = makeEl(doc, "div", "webpic-help_section-title");
    sectionTitle.textContent = section.title;
    col.appendChild(sectionTitle);
    for (const item of section.items) {
      const row = makeEl(doc, "div", "webpic-help_row");
      const keys = makeEl(doc, "kbd", "webpic-help_keys");
      keys.textContent = item.keys;
      const action = makeEl(doc, "span", "webpic-help_action");
      action.textContent = item.action;
      row.append(keys, action);
      col.appendChild(row);
    }
    grid.appendChild(col);
  }
  panel.appendChild(grid);
  overlay.appendChild(panel);
  parent.appendChild(overlay);

  const apply = (visible: boolean): void => {
    overlay.hidden = !visible;
  };
  apply(uiStore.getState().isHelpVisible);
  const unsub = uiStore.subscribe((s) => s.isHelpVisible, apply);

  // Backdrop click closes; the panel swallows its own clicks so a click inside doesn't dismiss.
  overlay.addEventListener("click", () => uiStore.getState().setHelpVisible(false));
  panel.addEventListener("click", (event) => event.stopPropagation());

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    // `?` is Shift+/ (layout-dependent key, stable code); `H` toggles with or without Shift.
    const isToggle =
      event.code === "KeyH" || (event.shiftKey && (event.key === "?" || event.code === "Slash"));
    if (isToggle) {
      event.preventDefault();
      uiStore.getState().toggleHelp();
    } else if (event.key === "Escape" && uiStore.getState().isHelpVisible) {
      uiStore.getState().setHelpVisible(false);
    }
  };
  doc.addEventListener("keydown", onKeyDown);

  return () => {
    doc.removeEventListener("keydown", onKeyDown);
    unsub();
    overlay.remove();
  };
}
