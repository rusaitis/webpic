import { makeEl } from "../controls/dom.ts";
import { ICON_CARET_FLAT } from "../icons.ts";
import { makeTopBarIconButton } from "./parts.ts";

// The chevron cluster at the bar's right edge: a reveal whose panel holds the (inert) upload /
// layers / layout actions, and which the compact layout borrows to host the relocated time scrub.
// Absolutely positioned, so opening it never widens the bar.

const ICON = {
  upload: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.5V2.5M5 5.5 8 2.5l3 3"/><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>`,
  layers: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 1.5 5.5 8 9l6.5-3.5L8 2Z"/><path d="m1.5 9.5 6.5 3.5 6.5-3.5"/></svg>`,
  layout: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M8 3.5v9"/></svg>`,
} as const;

export interface ActionsPanel {
  // The reveal wrapper the bar appends.
  readonly element: HTMLElement;
  // The reveal's trigger, handed to installReveal by the bar.
  readonly chevron: HTMLButtonElement;
  // The panel itself — the compact layout moves the time control into it.
  readonly panel: HTMLElement;
}

export function installActionsPanel(doc: Document): ActionsPanel {
  const element = makeEl(doc, "div", "webpic-topbar_reveal");
  const chevron = makeTopBarIconButton(doc, "more", ICON_CARET_FLAT, "More actions");
  chevron.classList.add("webpic-topbar_chevron");
  chevron.setAttribute("aria-haspopup", "true");
  chevron.setAttribute("aria-expanded", "false");

  const panel = makeEl(doc, "div", "webpic-topbar_pop webpic-topbar_actions");
  const grid = makeEl(doc, "div", "webpic-topbar_actions-grid");
  const placeholder = (control: string, icon: string, title: string): HTMLButtonElement => {
    const button = makeTopBarIconButton(doc, control, icon, `${title} (coming soon)`);
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    return button;
  };
  grid.append(
    placeholder("upload", ICON.upload, "Upload data"),
    placeholder("layers", ICON.layers, "Layers"),
    placeholder("layout", ICON.layout, "Compare / layout"),
  );
  panel.append(grid); // the compact bar appends the relocated time scrub below this grid
  element.append(chevron, panel);

  return { element, chevron, panel };
}
