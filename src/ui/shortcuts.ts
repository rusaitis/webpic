// Single source of truth for the keyboard cheat-sheet (ui/helpOverlay). The bindings themselves
// still live as logic in ui/pointerCamera + ui/install; keep this list in step until the
// theme-shortcut system (schema/theme.ts) drives both. Grouped for display only.

export interface Shortcut {
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
    title: "View",
    items: [
      { keys: "R", action: "Reset view" },
      { keys: "Z", action: "Fit data" },
      { keys: "O", action: "Toggle orthographic" },
      { keys: "F", action: "Toggle UI" },
      { keys: "? · H", action: "Toggle this help" },
    ],
  },
];
