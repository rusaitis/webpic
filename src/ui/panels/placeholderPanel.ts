import { createPane, type Disposer } from "../controls/index.ts";

// A titled panel with a single note — keeps the shell layout honest (every default panel
// renders) before a panel's real bindings land, without faking functionality.

export function installPlaceholderPanel(host: HTMLElement, title: string, note: string): Disposer {
  const pane = createPane({ parent: host, title });
  pane.addFolder({ title }).addNote(note);
  return () => pane.dispose();
}
