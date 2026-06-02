import { createPane, type Disposer } from "../controls/index.ts";

// A titled panel with a single note — keeps the shell layout honest (every default panel
// renders) before a panel's real bindings land, without faking functionality.

export function installPlaceholderPanel(host: HTMLElement, title: string, note: string): Disposer {
  const pane = createPane({ parent: host, title });
  const folder = pane.addFolder({ title });
  const noteEl = host.ownerDocument.createElement("div");
  noteEl.className = "webpic-placeholder";
  noteEl.textContent = note;
  folder.element.appendChild(noteEl);
  return () => pane.dispose();
}
