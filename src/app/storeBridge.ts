import type { SimulationState, SimulationStore } from "@store";

// Shared plumbing for the store→render-worker bridges (app-only glue). It collects subscription
// disposers so teardown is a single `dispose()` (no hand-maintained unsubscribe lists to fall out of
// sync), and folds in the common "drop posts until the worker is live" gate via `subscribeWhenReady`.
// Bridges whose gate isn't the plain isReady() check — layerSync keeps a snapshot while not ready,
// streamingBridge gates on its own `opened` flag — use the raw `subscribe` and keep their own guard.
export interface StoreBridge {
  /** Subscribe; the listener runs only once `isReady()` — the common store→worker gate. */
  subscribeWhenReady<T>(
    selector: (state: SimulationState) => T,
    listener: (value: T) => void,
  ): void;
  /** Subscribe unconditionally — the listener owns its gating. Disposer still collected. */
  subscribe<T>(selector: (state: SimulationState) => T, listener: (value: T) => void): void;
  dispose(): void;
}

export function createStoreBridge(store: SimulationStore, isReady: () => boolean): StoreBridge {
  const disposers: Array<() => void> = [];
  return {
    subscribeWhenReady(selector, listener) {
      disposers.push(
        store.subscribe(selector, (value) => {
          if (isReady()) listener(value);
        }),
      );
    },
    subscribe(selector, listener) {
      disposers.push(store.subscribe(selector, listener));
    },
    dispose() {
      for (const dispose of disposers) dispose();
    },
  };
}
