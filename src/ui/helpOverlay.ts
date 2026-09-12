import type { UiStore } from "@store";
import { makeEl } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";
import { createShortcutRegistry, SHORTCUTS } from "./shortcuts.ts";
import { createSubscriptions } from "./subscriptions.ts";

// Keyboard cheat-sheet: a centered modal toggled with `?` (Shift+/) or `H`, Escape or a backdrop
// click to close. install*() => Disposer. Visibility rides the ui store's help flag so any
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

  const abortController = new AbortController();
  const subscriptions = createSubscriptions();
  subscriptions.on(
    uiStore,
    (s) => s.isHelpVisible,
    (visible) => {
      overlay.hidden = !visible;
    },
    { shouldFireNow: true },
  );

  // Backdrop click closes; the panel swallows its own clicks so a click inside doesn't dismiss.
  overlay.addEventListener("click", () => uiStore.getState().setHelpVisible(false));
  panel.addEventListener("click", (event) => event.stopPropagation());

  // `?` is Shift+/ (layout-dependent key, stable code); `H` toggles with or without Shift. The
  // registry fires one binding per event, so a shifted "/" never toggles twice.
  const toggle = (): void => uiStore.getState().toggleHelp();
  const shortcuts = createShortcutRegistry(doc);
  shortcuts.register("KeyH", toggle, { modifiers: "any" });
  shortcuts.register("?", toggle, { modifiers: "shift" });
  shortcuts.register("Slash", toggle, { modifiers: "shift" });
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && uiStore.getState().isHelpVisible) {
      uiStore.getState().setHelpVisible(false);
    }
  };
  doc.addEventListener("keydown", onKeyDown, { signal: abortController.signal });

  return () => {
    abortController.abort();
    shortcuts.dispose();
    subscriptions.dispose();
    overlay.remove();
  };
}
