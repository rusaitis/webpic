import { createSimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installPointerPicker } from "./pointerPicker.ts";

// happy-dom: arrow keys drive the marker-slide intents. We assert the dispatched pickerPoint, not
// pixels — the render worker is out of scope. Held arrows integrate in a rAF loop, so direction
// tests pump a frame before asserting. Default pose azimuth is π/4: screenRight = (−√½, +√½, 0),
// into-screen horizontal = (−√½, −√½, 0).

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function setup(point: readonly [number, number, number] = [0, 0, 0]) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const store = createSimulationStore();
  store.getState().setOverlayShowPicker(true);
  store.getState().setPickerPoint([point[0], point[1], point[2]]);
  const dispose = installPointerPicker(target, store);
  disposers.push(dispose);
  return { target, store };
}

function key(type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { code, cancelable: true, ...init });
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("installPointerPicker arrow keys", () => {
  it("held arrows slide the marker view-relative on the equatorial plane", async () => {
    const { store } = setup();
    expect(document.dispatchEvent(key("keydown", "ArrowRight"))).toBe(false); // claimed — no scroll
    expect(store.getState().pickerActive).toBe(true); // a keyboard move is a grab, not a placement
    await frame();
    const p = store.getState().pickerPoint;
    expect(p?.[0]).toBeLessThan(0); // screen-right at azimuth π/4 = (−√½, +√½, 0)
    expect(p?.[1]).toBeGreaterThan(0);
    expect(p?.[2]).toBe(0);
    document.dispatchEvent(key("keyup", "ArrowRight"));
    expect(store.getState().pickerActive).toBe(false);
  });

  it("↑ moves into the screen; Shift+↑ moves vertically instead", async () => {
    const { store } = setup();
    document.dispatchEvent(key("keydown", "ArrowUp"));
    await frame();
    const flat = store.getState().pickerPoint;
    expect(flat?.[0]).toBeLessThan(0); // into-screen at azimuth π/4 = (−√½, −√½, 0)
    expect(flat?.[1]).toBeLessThan(0);
    expect(flat?.[2]).toBe(0);
    document.dispatchEvent(key("keyup", "ArrowUp"));

    store.getState().setPickerPoint([0, 0, 0]);
    document.dispatchEvent(key("keydown", "ArrowUp", { shiftKey: true }));
    await frame();
    const vertical = store.getState().pickerPoint;
    expect(vertical?.[2]).toBeGreaterThan(0);
    expect(vertical?.[0]).toBeCloseTo(0, 12);
    expect(vertical?.[1]).toBeCloseTo(0, 12);
    document.dispatchEvent(key("keyup", "ArrowUp"));
  });

  it("clamps the keyboard slide to the box", async () => {
    const { store } = setup([0, 0, 0.5]);
    document.dispatchEvent(key("keydown", "ArrowUp", { shiftKey: true }));
    await frame();
    await frame();
    expect(store.getState().pickerPoint?.[2]).toBe(0.5);
    document.dispatchEvent(key("keyup", "ArrowUp"));
  });

  it("ignores arrows while the picker is hidden", async () => {
    const { store } = setup();
    store.getState().setOverlayShowPicker(false);
    expect(document.dispatchEvent(key("keydown", "ArrowRight"))).toBe(true); // unclaimed
    await frame();
    expect(store.getState().pickerPoint).toEqual([0, 0, 0]);
    expect(store.getState().pickerActive).toBe(false);
  });

  it("ignores arrows while typing in an input", async () => {
    const { store } = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
    await frame();
    expect(store.getState().pickerPoint).toEqual([0, 0, 0]);
  });

  it("drops held arrows when a modifier chord starts (macOS swallows those keyups)", async () => {
    const { store } = setup();
    document.dispatchEvent(key("keydown", "ArrowRight"));
    expect(store.getState().pickerActive).toBe(true);
    document.dispatchEvent(key("keydown", "MetaLeft", { metaKey: true }));
    expect(store.getState().pickerActive).toBe(false);
    const stopped = store.getState().pickerPoint;
    await frame();
    expect(store.getState().pickerPoint).toEqual(stopped); // loop stopped — no drift
  });

  it("clears held arrows when the window blurs (no stuck motion)", async () => {
    const { store } = setup();
    document.dispatchEvent(key("keydown", "ArrowRight"));
    expect(store.getState().pickerActive).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(store.getState().pickerActive).toBe(false);
  });
});
