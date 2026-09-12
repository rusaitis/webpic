import type { Disposer } from "./controls/index.ts";
import { isTypingTarget } from "./keyboard.ts";

// Bare-key shortcuts: one registry implementation with the single guard set every binding shares —
// a typing surface keeps its keystrokes, a Meta/Ctrl/Alt chord is never a shortcut, an already-
// handled event (defaultPrevented) stays handled. Each subsystem creates its own registry on the
// document (ui/install, ui/pointerCamera, the panels); a matched key is claimed (preventDefault) so
// the page gets no quick-find / scroll side effect. SHORTCUTS below is the cheat-sheet the help
// overlay renders — keep it in step with the registrations until the theme-shortcut system
// (schema/theme.ts) drives both.

interface ShortcutOptions {
  /** Shift requirement: "none" (default) fires only unshifted, "shift" only shifted, "any" ignores it. */
  readonly modifiers?: "none" | "shift" | "any";
}

export interface ShortcutRegistry {
  /** `key` names the physical key (event.code — "KeyC", "Digit1", "Slash") or the layout key
   *  (event.key, case-insensitive — "f", "?", "Escape"). The first registration to match wins. */
  register(key: string, handler: (event: KeyboardEvent) => void, options?: ShortcutOptions): void;
  dispose(): void;
}

interface Binding {
  readonly code: string;
  readonly key: string; // lower-cased event.key form
  readonly modifiers: "none" | "shift" | "any";
  readonly handler: (event: KeyboardEvent) => void;
}

export function createShortcutRegistry(doc: Document, signal?: AbortSignal): ShortcutRegistry {
  const bindings: Binding[] = [];
  // Signal-bound only (no removeEventListener): a caller's signal and dispose() both tear it down.
  const ac = new AbortController();
  const teardown = signal === undefined ? ac.signal : AbortSignal.any([signal, ac.signal]);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    for (const binding of bindings) {
      if (binding.code !== event.code && binding.key !== key) continue;
      if (binding.modifiers === "none" && event.shiftKey) continue;
      if (binding.modifiers === "shift" && !event.shiftKey) continue;
      event.preventDefault();
      binding.handler(event);
      return;
    }
  };
  doc.addEventListener("keydown", onKeyDown, { signal: teardown });
  const dispose: Disposer = () => ac.abort();

  return {
    register(key, handler, options) {
      bindings.push({
        code: key,
        key: key.toLowerCase(),
        modifiers: options?.modifiers ?? "none",
        handler,
      });
    },
    dispose,
  };
}

interface Shortcut {
  readonly keys: string;
  readonly action: string;
}

export interface ShortcutSection {
  readonly title: string;
  readonly items: readonly Shortcut[];
}

export const SHORTCUTS: readonly ShortcutSection[] = [
  {
    title: "Orbit & move",
    items: [
      { keys: "drag", action: "Orbit" },
      { keys: "shift / right / middle drag", action: "Pan" },
      { keys: "wheel · pinch", action: "Zoom (flies through up close)" },
      { keys: "A · D", action: "Orbit left / right" },
      { keys: "Q · E", action: "Orbit down / up" },
      { keys: "W · S", action: "Zoom in / out" },
    ],
  },
  {
    title: "Roll",
    items: [
      { keys: "Shift+Q · Shift+E", action: "Bank left / right" },
      { keys: "Shift+R", action: "Level the horizon" },
    ],
  },
  {
    title: "Snap views",
    items: [
      { keys: "1 · 2", action: "Front / back (±x)" },
      { keys: "3 · 4", action: "Right / left (±y)" },
      { keys: "5 · 6", action: "Top / bottom (±z)" },
      { keys: "0 · `", action: "Default 3/4 view" },
      { keys: "double-click", action: "Focus under cursor" },
    ],
  },
  {
    title: "Layers",
    items: [
      { keys: "L", action: "Toggle Layers panel" },
      { keys: "V", action: "Add volume" },
      { keys: "T", action: "Add field lines" },
    ],
  },
  {
    title: "View",
    items: [
      { keys: "R", action: "Reset view" },
      { keys: "Z", action: "Fit data" },
      { keys: "N", action: "Toggle fly mode (A/D/Q/E look)" },
      { keys: "O", action: "Toggle orthographic" },
      { keys: "F", action: "Toggle UI" },
      { keys: "P", action: "Save PNG screenshot" },
      { keys: "C", action: "Coordinates & grid info" },
      { keys: "Shift+P", action: "Toggle performance HUD (dev)" },
      { keys: "? · H", action: "Toggle this help" },
    ],
  },
];
