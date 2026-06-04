import { describe, expect, it } from "vitest";
import { createUiStore } from "./ui.ts";

describe("uiStore", () => {
  it("toggles global UI visibility", () => {
    const store = createUiStore();
    expect(store.getState().isUiVisible).toBe(true);
    store.getState().toggleUi();
    expect(store.getState().isUiVisible).toBe(false);
    store.getState().setUiVisible(true);
    expect(store.getState().isUiVisible).toBe(true);
  });

  it("toggles per-panel visibility (defaulting unseen panels to visible)", () => {
    const store = createUiStore({ field: true });
    store.getState().togglePanel("field");
    expect(store.getState().panels.field).toBe(false);
    store.getState().togglePanel("colormap"); // unseen → defaults visible, so toggles to false
    expect(store.getState().panels.colormap).toBe(false);
    store.getState().setPanelVisible("colormap", true);
    expect(store.getState().panels.colormap).toBe(true);
  });

  it("fires selective subscribers on the relevant slice only", () => {
    const store = createUiStore();
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(
      (s) => s.isUiVisible,
      (v) => seen.push(v),
    );
    store.getState().togglePanel("x"); // unrelated slice — must not fire
    store.getState().toggleUi();
    unsubscribe();
    store.getState().toggleUi(); // after unsubscribe — must not fire
    expect(seen).toEqual([false]);
  });
});
