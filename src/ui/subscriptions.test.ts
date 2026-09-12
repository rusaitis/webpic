import { createUiStore } from "@store";
import { describe, expect, it } from "vitest";
import { createSubscriptions } from "./subscriptions.ts";

describe("createSubscriptions", () => {
  it("tracks a selector slice and stops on dispose", () => {
    const store = createUiStore();
    const subscriptions = createSubscriptions();
    const seen: boolean[] = [];
    subscriptions.on(
      store,
      (s) => s.isUiVisible,
      (visible) => seen.push(visible),
    );
    expect(seen).toEqual([]); // no fireNow → nothing until a change
    store.getState().setUiVisible(false);
    expect(seen).toEqual([false]);
    subscriptions.dispose();
    store.getState().setUiVisible(true);
    expect(seen).toEqual([false]);
  });

  it("fireNow applies the current slice on subscribe", () => {
    const store = createUiStore();
    const subscriptions = createSubscriptions();
    const seen: boolean[] = [];
    subscriptions.on(
      store,
      (s) => s.isHelpVisible,
      (visible) => seen.push(visible),
      { fireNow: true },
    );
    expect(seen).toEqual([false]);
    subscriptions.dispose();
  });

  it("honours a custom equalityFn", () => {
    const store = createUiStore();
    const subscriptions = createSubscriptions();
    let fired = 0;
    // A fresh-object selector fires on every state change under Object.is; a value comparison mutes it.
    subscriptions.on(
      store,
      (s) => ({ open: s.isLayersPanelOpen }),
      () => fired++,
      { equalityFn: (a, b) => a.open === b.open },
    );
    store.getState().setUiVisible(false); // unrelated change
    expect(fired).toBe(0);
    store.getState().toggleLayersPanel();
    expect(fired).toBe(1);
    subscriptions.dispose();
  });

  it("runs added disposers and subscriptions LIFO, once", () => {
    const store = createUiStore();
    const subscriptions = createSubscriptions();
    const order: string[] = [];
    subscriptions.add(() => order.push("first"));
    subscriptions.on(
      store,
      (s) => s.isUiVisible,
      () => {},
    );
    subscriptions.add(() => order.push("last"));
    subscriptions.dispose();
    subscriptions.dispose(); // idempotent — nothing left to run
    expect(order).toEqual(["last", "first"]);
  });
});
