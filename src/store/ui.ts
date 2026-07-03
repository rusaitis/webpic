import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

// UI state, separate from simulation data: a global show/hide, per-panel visibility, and
// the status-pill facts (loading phases + error notice). The `ui` layer dispatches these
// intents and subscribes selectively — it holds no state of its own. Panel collapse
// (folder expanded/hidden) is a DOM concern, not store state; this tracks whether a panel
// is shown at all. The store holds synchronous facts only — show-delay/min-visible/error
// timers are presentation policy and live in the statusPill component.

export interface LoadingPhase {
  readonly key: string;
  readonly message: string;
  readonly kind: "loading" | "task"; // "task" reserved for future dismissible jobs
}

/** The cold-start phase: begun at bootstrap, ended on the worker's first frame. Shared
 *  so the app (who runs it) and the ui's boot reveal (who watches it) agree on the key. */
export const BOOT_PHASE_KEY = "boot";

export interface UiState {
  readonly isUiVisible: boolean;
  readonly isHelpVisible: boolean;
  readonly isCoordsInfoVisible: boolean;
  /** The rail-toggled Layers overlay (M4.7) — a collapsible workspace panel, default closed
   *  (`layers-collapsed-default`). Distinct from `panels` (docked-shell visibility). */
  readonly isLayersPanelOpen: boolean;
  /** The per-layer settings window (M4.8), opened from the Layers-panel gear or the rail's "Add new".
   *  Bound to the selected layer; default closed. Distinct from `isLayersPanelOpen` (the list overlay). */
  readonly isLayerSettingsOpen: boolean;
  /** Responsive override: the bottom band is too narrow to hold the gnomon beside the centered
   *  rail, so the gnomon is hidden until there's room again. Distinct from the user's gnomon
   *  preference (overlay.showGnomon) — it only suppresses, never enables. The colorbar (the
   *  bottom-band coordinator) writes it; the rail + gnomon consume it. */
  readonly isGnomonSuppressed: boolean;
  readonly panels: Readonly<Record<string, boolean>>;
  /** Insertion-ordered; the pill shows while nonempty and the oldest entry owns the
   *  message — newest-wins reverts the text when a later phase ends first (A→B→A). */
  readonly loadingPhases: readonly LoadingPhase[];
  readonly statusError: { readonly message: string } | null;
  /** Monotonic PNG-capture trigger: each request increments, subscribers fire per change — no
   *  consume/reset ping-pong. The app bridge owns the capture; ui only dispatches the intent. */
  readonly screenshotSerial: number;
  /** The active theme's name (slug, e.g. "catppuccin-mocha"); null until the app seeds it. The app
   *  theme bridge owns the bundled list + application — ui reads this for display only. */
  readonly themeName: string | null;
  /** Monotonic cycle-to-next-theme trigger (rail button), same shape as screenshotSerial. */
  readonly themeCycleSerial: number;
  toggleUi(): void;
  setUiVisible(visible: boolean): void;
  toggleHelp(): void;
  setHelpVisible(visible: boolean): void;
  toggleCoordsInfo(): void;
  setCoordsInfoVisible(visible: boolean): void;
  toggleLayersPanel(): void;
  setLayersPanelVisible(visible: boolean): void;
  toggleLayerSettings(): void;
  setLayerSettingsVisible(visible: boolean): void;
  setGnomonSuppressed(suppressed: boolean): void;
  togglePanel(name: string): void;
  setPanelVisible(name: string, visible: boolean): void;
  beginLoading(key: string, message: string): void;
  endLoading(key: string): void;
  flashError(message: string): void;
  clearError(): void;
  requestScreenshot(): void;
  setThemeName(name: string): void;
  requestThemeCycle(): void;
}

// Inferred from the factory so the `subscribeWithSelector` overload survives (a plain
// StoreApi<UiState> annotation would erase it) — mirrors createSimulationStore.
export type UiStore = ReturnType<typeof createUiStore>;

export function createUiStore(initialPanels: Readonly<Record<string, boolean>> = {}) {
  return createStore<UiState>()(
    subscribeWithSelector((set, get) => ({
      isUiVisible: true,
      isHelpVisible: false,
      isCoordsInfoVisible: false,
      isLayersPanelOpen: false,
      isLayerSettingsOpen: false,
      isGnomonSuppressed: false,
      panels: initialPanels,
      loadingPhases: [],
      statusError: null,
      screenshotSerial: 0,
      requestScreenshot() {
        set({ screenshotSerial: get().screenshotSerial + 1 });
      },
      themeName: null,
      themeCycleSerial: 0,
      setThemeName(name) {
        if (get().themeName !== name) set({ themeName: name });
      },
      requestThemeCycle() {
        set({ themeCycleSerial: get().themeCycleSerial + 1 });
      },
      toggleUi() {
        set({ isUiVisible: !get().isUiVisible });
      },
      setUiVisible(visible) {
        set({ isUiVisible: visible });
      },
      toggleHelp() {
        set({ isHelpVisible: !get().isHelpVisible });
      },
      setHelpVisible(visible) {
        if (get().isHelpVisible !== visible) set({ isHelpVisible: visible });
      },
      toggleCoordsInfo() {
        set({ isCoordsInfoVisible: !get().isCoordsInfoVisible });
      },
      setCoordsInfoVisible(visible) {
        if (get().isCoordsInfoVisible !== visible) set({ isCoordsInfoVisible: visible });
      },
      toggleLayersPanel() {
        set({ isLayersPanelOpen: !get().isLayersPanelOpen });
      },
      setLayersPanelVisible(visible) {
        if (get().isLayersPanelOpen !== visible) set({ isLayersPanelOpen: visible });
      },
      toggleLayerSettings() {
        set({ isLayerSettingsOpen: !get().isLayerSettingsOpen });
      },
      setLayerSettingsVisible(visible) {
        if (get().isLayerSettingsOpen !== visible) set({ isLayerSettingsOpen: visible });
      },
      setGnomonSuppressed(suppressed) {
        if (get().isGnomonSuppressed !== suppressed) set({ isGnomonSuppressed: suppressed });
      },
      togglePanel(name) {
        const { panels } = get();
        set({ panels: { ...panels, [name]: !(panels[name] ?? true) } });
      },
      setPanelVisible(name, visible) {
        set({ panels: { ...get().panels, [name]: visible } });
      },
      // Re-begin of a live key retitles it in place (insertion order is display order);
      // a same-key same-message begin is a no-op so rapid scrub retitles don't refire.
      beginLoading(key, message) {
        const phases = get().loadingPhases;
        const existing = phases.find((p) => p.key === key);
        if (existing !== undefined && existing.message === message) return;
        set({
          loadingPhases:
            existing !== undefined
              ? phases.map((p) => (p.key === key ? { key, message, kind: p.kind } : p))
              : [...phases, { key, message, kind: "loading" }],
        });
      },
      endLoading(key) {
        const phases = get().loadingPhases;
        if (!phases.some((p) => p.key === key)) return;
        set({ loadingPhases: phases.filter((p) => p.key !== key) });
      },
      // Fresh object per call so a repeated identical error still refires the selector
      // (the pill restarts its auto-clear timer).
      flashError(message) {
        set({ statusError: { message } });
      },
      clearError() {
        if (get().statusError !== null) set({ statusError: null });
      },
    })),
  );
}
