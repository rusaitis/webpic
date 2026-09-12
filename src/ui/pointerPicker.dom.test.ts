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

// The pointer path: a drag on the marker core. happy-dom measures every rect as 0×0, so the target's
// geometry is stubbed — the marker projects to the middle of a 800×600 canvas at the default pose.
function stubCanvasRect(target: HTMLElement): void {
  target.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  target.setPointerCapture = () => {};
  target.releasePointerCapture = () => {};
}

// `buttons` matters: the hover branch bails while a button is held, because a camera drag owns the
// gesture then. 0 is a plain hover; 1 is the primary button held through a drag.
function pointer(target: HTMLElement, type: string, x: number, y: number, buttons = 0): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.assign(event, {
    clientX: x,
    clientY: y,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons,
  });
  target.dispatchEvent(event);
}

describe("installPointerPicker pointer drag", () => {
  it("grabs the marker core, moves it across the view plane, and releases", () => {
    const { target, store } = setup([0, 0, 0]);
    stubCanvasRect(target);
    const start = store.getState().pickerPoint;

    pointer(target, "pointerdown", 400, 300); // the marker projects to the canvas centre
    expect(store.getState().pickerActive).toBe(true);

    pointer(target, "pointermove", 460, 300);
    const dragged = store.getState().pickerPoint;
    expect(dragged).not.toEqual(start); // the drag moved it

    pointer(target, "pointerup", 460, 300);
    expect(store.getState().pickerActive).toBe(false);
    expect(store.getState().pickerPoint).toEqual(dragged); // release commits where it landed
  });

  it("ignores a press that misses the marker, leaving the camera to handle it", () => {
    const { target, store } = setup([0, 0, 0]);
    stubCanvasRect(target);
    const start = store.getState().pickerPoint;

    pointer(target, "pointerdown", 780, 20); // far corner — nowhere near the marker
    expect(store.getState().pickerActive).toBe(false);
    pointer(target, "pointermove", 700, 100);
    expect(store.getState().pickerPoint).toEqual(start);
  });

  it("reports hover on the core so the cursor and the marker can respond", () => {
    const { target, store } = setup([0, 0, 0]);
    stubCanvasRect(target);

    pointer(target, "pointermove", 400, 300);
    expect(store.getState().pickerHover).toBe("core");

    pointer(target, "pointermove", 780, 20);
    expect(store.getState().pickerHover).toBe("none");
  });

  it("ends a drag the browser cancels without stranding the active flag", () => {
    const { target, store } = setup([0, 0, 0]);
    stubCanvasRect(target);

    pointer(target, "pointerdown", 400, 300);
    expect(store.getState().pickerActive).toBe(true);
    pointer(target, "pointercancel", 400, 300);
    expect(store.getState().pickerActive).toBe(false);
  });

  it("stops driving the marker once disposed mid-drag", () => {
    const { target, store } = setup([0, 0, 0]);
    stubCanvasRect(target);

    pointer(target, "pointerdown", 400, 300);
    pointer(target, "pointermove", 440, 300);
    const midDrag = store.getState().pickerPoint;

    for (const dispose of disposers.splice(0)) dispose();
    pointer(target, "pointermove", 600, 300);
    expect(store.getState().pickerPoint).toEqual(midDrag);
  });
});
