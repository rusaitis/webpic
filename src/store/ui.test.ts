import { describe, expect, it } from "vitest";
import { createUiStore, PHASE_KEYS } from "./ui.ts";

describe("uiStore", () => {
  it("toggles global UI visibility", () => {
    const store = createUiStore();
    expect(store.getState().isUiVisible).toBe(true);
    store.getState().toggleUi();
    expect(store.getState().isUiVisible).toBe(false);
    store.getState().setUiVisible(true);
    expect(store.getState().isUiVisible).toBe(true);
  });

  it("toggles the coordinates/grid-info popover, guarding no-op sets", () => {
    const store = createUiStore();
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(
      (s) => s.isCoordsInfoVisible,
      (v) => seen.push(v),
    );
    expect(store.getState().isCoordsInfoVisible).toBe(false);
    store.getState().toggleCoordsInfo();
    expect(store.getState().isCoordsInfoVisible).toBe(true);
    store.getState().setCoordsInfoVisible(true); // unchanged → no fire
    store.getState().setCoordsInfoVisible(false);
    unsubscribe();
    expect(seen).toEqual([true, false]);
  });

  it("toggles the Layers overlay, guarding no-op sets", () => {
    const store = createUiStore();
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(
      (s) => s.isLayersPanelOpen,
      (v) => seen.push(v),
    );
    expect(store.getState().isLayersPanelOpen).toBe(false);
    store.getState().toggleLayersPanel();
    expect(store.getState().isLayersPanelOpen).toBe(true);
    store.getState().setLayersPanelVisible(true); // unchanged → no fire
    store.getState().setLayersPanelVisible(false);
    unsubscribe();
    expect(seen).toEqual([true, false]);
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

  it("keeps loading phases keyed and nested (active while any phase remains)", () => {
    const store = createUiStore();
    store.getState().beginLoading("boot", "webpic");
    store.getState().beginLoading("step", "loading step 2");
    expect(store.getState().loadingPhases.map((p) => p.key)).toEqual(["boot", "step"]);
    expect(store.getState().loadingPhases[0]?.message).toBe("webpic");
    store.getState().endLoading("boot");
    expect(store.getState().loadingPhases).toHaveLength(1);
    store.getState().endLoading("step");
    expect(store.getState().loadingPhases).toEqual([]);
  });

  it("re-begin of a live key retitles in place, preserving insertion order", () => {
    const store = createUiStore();
    store.getState().beginLoading("step", "loading step 1");
    store.getState().beginLoading("open", "opening dataset");
    store.getState().beginLoading("step", "loading step 2");
    const phases = store.getState().loadingPhases;
    expect(phases.map((p) => p.key)).toEqual(["step", "open"]);
    expect(phases[0]?.message).toBe("loading step 2");
  });

  it("treats no-op begin/end as silent (no subscriber fire)", () => {
    const store = createUiStore();
    store.getState().beginLoading("step", "loading step 1");
    let fires = 0;
    const unsubscribe = store.subscribe(
      (s) => s.loadingPhases,
      () => {
        fires += 1;
      },
    );
    store.getState().beginLoading("step", "loading step 1"); // identical — silent
    store.getState().endLoading(PHASE_KEYS.screenshot); // a key that is not active — silent
    expect(fires).toBe(0);
    store.getState().endLoading("step");
    expect(fires).toBe(1);
    unsubscribe();
  });

  it("increments the screenshot serial per request (monotonic trigger)", () => {
    const store = createUiStore();
    const serials: number[] = [];
    const unsubscribe = store.subscribe(
      (s) => s.screenshotSerial,
      (serial) => serials.push(serial),
    );
    expect(store.getState().screenshotSerial).toBe(0);
    store.getState().requestScreenshot();
    store.getState().requestScreenshot(); // repeats must refire — each is a fresh capture ask
    expect(serials).toEqual([1, 2]);
    unsubscribe();
  });

  it("holds the theme name (identity-skipped) and a cycle serial that always refires", () => {
    const store = createUiStore();
    let nameFires = 0;
    let cycleFires = 0;
    const unsubName = store.subscribe(
      (s) => s.themeName,
      () => {
        nameFires += 1;
      },
    );
    const unsubCycle = store.subscribe(
      (s) => s.themeCycleSerial,
      () => {
        cycleFires += 1;
      },
    );
    expect(store.getState().themeName).toBeNull();
    store.getState().setThemeName("dark");
    store.getState().setThemeName("dark"); // identity — silent
    expect(nameFires).toBe(1);
    store.getState().requestThemeCycle();
    store.getState().requestThemeCycle(); // monotonic — every request fires
    expect(cycleFires).toBe(2);
    unsubName();
    unsubCycle();
  });

  it("flashes errors with fresh identity so repeats refire", () => {
    const store = createUiStore();
    const seen: (string | undefined)[] = [];
    const unsubscribe = store.subscribe(
      (s) => s.statusError,
      (e) => seen.push(e?.message),
    );
    store.getState().flashError("stream failed");
    store.getState().flashError("stream failed"); // same text, new object — must refire
    store.getState().clearError();
    store.getState().clearError(); // already null — silent
    expect(seen).toEqual(["stream failed", "stream failed", undefined]);
    unsubscribe();
  });
});
