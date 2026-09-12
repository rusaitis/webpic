import type { Theme } from "@schema/theme.ts";
import type { UiStore } from "@store";

// Theme-switcher glue (app-only: ui dispatches the cycle intent, the app owns the bundled catalog
// + application + persistence). The rail button bumps uiStore.themeCycleSerial → advance to the
// next catalog theme (wrapping, catalog insertion order); every themeName change — the boot seed
// included — applies through the injected callback (CSS vars + the worker overlay/marker palettes)
// and persists best-effort.

export interface ThemeBridgeOptions {
  readonly uiStore: UiStore;
  /** Bundled themes keyed by name (loadBundledThemes()); insertion order is the cycle order. */
  readonly themes: ReadonlyMap<string, Theme>;
  /** The boot theme's name (persisted pref or the default); seeded into the store on install. */
  readonly initialName: string;
  /** Applies a theme everywhere it lives: UI CSS vars + the render worker's overlay/marker colors. */
  readonly applyTheme: (theme: Theme) => void;
  /** Persists the choice (OPFS); best-effort fire-and-forget. */
  readonly persist: (name: string) => Promise<void>;
}

export function installThemeBridge(options: ThemeBridgeOptions): () => void {
  const { uiStore, themes, applyTheme, persist } = options;
  const names = [...themes.keys()];

  const unsubscribeName = uiStore.subscribe(
    (state) => state.themeName,
    (name) => {
      if (name === null) return;
      const theme = themes.get(name);
      if (theme === undefined) return; // foreign name (stale pref) — keep the current theme
      applyTheme(theme);
      void persist(name).catch(() => {}); // persist never throws by contract; belt-and-braces
    },
  );

  const unsubscribeCycle = uiStore.subscribe(
    (state) => state.themeCycleSerial,
    () => {
      const current = uiStore.getState().themeName;
      const index = current === null ? -1 : names.indexOf(current);
      const next = names[(index + 1) % names.length];
      if (next !== undefined) uiStore.getState().setThemeName(next);
    },
  );

  // Seed the boot theme through the same path a cycle takes: the subscription applies + persists.
  // The boot styles were already installed with this theme, so the re-apply is an idempotent no-op
  // visually; persisting the resolved name heals a stale/foreign pref in place.
  uiStore.getState().setThemeName(options.initialName);

  return () => {
    unsubscribeName();
    unsubscribeCycle();
  };
}
