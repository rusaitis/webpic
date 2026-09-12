import type { Disposer } from "./controls/index.ts";

// One teardown shape for every ui component that subscribes to a store (the app-side twin is
// app/storeBridge): `on` collects each selector subscription's unsubscribe, `add` folds in any other
// cleanup (a timer, a DOM listener), and `dispose` runs them all LIFO — no hand-ordered unsub lists
// to fall out of step with the subscriptions they mirror. Idempotent: a defensive double-dispose
// finds nothing left to run.

/** The selector-subscribe surface the vanilla `subscribeWithSelector` stores share (SimulationStore,
 *  UiStore, PerfStore). Structural, so it never names a store type. */
interface SelectorStore<S> {
  getState(): S;
  subscribe<U>(
    selector: (state: S) => U,
    listener: (value: U, previous: U) => void,
    options?: {
      readonly equalityFn?: ((a: U, b: U) => boolean) | undefined;
      readonly fireImmediately?: boolean | undefined;
    },
  ): () => void;
}

interface SubscribeOptions<U> {
  /** Run the listener once with the current slice on subscribe (the usual "apply, then track"). */
  readonly fireNow?: boolean;
  /** Slice comparison; default is `Object.is`. Pass zustand's `shallow` for fresh-array selectors. */
  readonly equalityFn?: (a: U, b: U) => boolean;
}

export interface Subscriptions {
  on<S, U>(
    store: SelectorStore<S>,
    selector: (state: S) => U,
    listener: (value: U) => void,
    options?: SubscribeOptions<U>,
  ): void;
  add(disposer: Disposer): void;
  dispose(): void;
}

export function createSubscriptions(): Subscriptions {
  const disposers: Disposer[] = [];
  return {
    on(store, selector, listener, options) {
      disposers.push(
        store.subscribe(selector, listener, {
          equalityFn: options?.equalityFn,
          fireImmediately: options?.fireNow,
        }),
      );
    },
    add(disposer) {
      disposers.push(disposer);
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}
