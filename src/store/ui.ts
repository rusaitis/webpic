import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

// UI state, separate from simulation data: a global show/hide and per-panel visibility.
// The `ui` layer dispatches these intents and subscribes selectively — it holds no state
// of its own. Panel collapse (folder expanded/hidden) is a DOM concern, not store state;
// this tracks whether a panel is shown at all.

export interface UiState {
  readonly isUiVisible: boolean;
  readonly panels: Readonly<Record<string, boolean>>;
  toggleUi(): void;
  setUiVisible(visible: boolean): void;
  togglePanel(name: string): void;
  setPanelVisible(name: string, visible: boolean): void;
}

// Inferred from the factory so the `subscribeWithSelector` overload survives (a plain
// StoreApi<UiState> annotation would erase it) — mirrors createSimulationStore.
export type UiStore = ReturnType<typeof createUiStore>;

export function createUiStore(initialPanels: Readonly<Record<string, boolean>> = {}) {
  return createStore<UiState>()(
    subscribeWithSelector((set, get) => ({
      isUiVisible: true,
      panels: initialPanels,
      toggleUi() {
        set({ isUiVisible: !get().isUiVisible });
      },
      setUiVisible(visible) {
        set({ isUiVisible: visible });
      },
      togglePanel(name) {
        const { panels } = get();
        set({ panels: { ...panels, [name]: !(panels[name] ?? true) } });
      },
      setPanelVisible(name, visible) {
        set({ panels: { ...get().panels, [name]: visible } });
      },
    })),
  );
}
