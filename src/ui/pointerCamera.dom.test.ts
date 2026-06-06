import { createSimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installPointerCamera } from "./pointerCamera.ts";

// happy-dom: pointer/wheel events drive the orbit-pose intents. We assert the dispatched pose,
// not pixels — the render worker is out of scope here.

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function setup() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const store = createSimulationStore();
  const dispose = installPointerCamera(target, store);
  disposers.push(dispose);
  return { target, store, dispose };
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, ...init });
}

describe("installPointerCamera", () => {
  it("orbits on left-drag: horizontal spins azimuth, vertical tilts elevation", () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;

    target.dispatchEvent(pointer("pointerdown", 100, 100));
    target.dispatchEvent(pointer("pointermove", 160, 100)); // drag right
    const afterX = store.getState().cameraPose;
    expect(afterX.azimuth).toBeLessThan(start.azimuth);
    expect(afterX.elevation).toBeCloseTo(start.elevation, 12);
    expect(afterX.target).toBe(start.target); // orbit never moves the target

    target.dispatchEvent(pointer("pointermove", 160, 140)); // then drag down
    expect(store.getState().cameraPose.elevation).toBeGreaterThan(afterX.elevation); // down ⇒ rises
  });

  it("pans on shift-drag: only the target moves", () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;

    target.dispatchEvent(pointer("pointerdown", 50, 50, { shiftKey: true }));
    target.dispatchEvent(pointer("pointermove", 90, 80, { shiftKey: true }));

    const pose = store.getState().cameraPose;
    expect(pose.azimuth).toBe(start.azimuth);
    expect(pose.elevation).toBe(start.elevation);
    expect(pose.distance).toBe(start.distance);
    expect(pose.target).not.toEqual(start.target);
  });

  it("dollies on wheel: scroll up zooms in (distance shrinks)", () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;
    target.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true }));
    expect(store.getState().cameraPose.distance).toBeLessThan(start.distance);
  });

  it("ignores moves with no active drag", () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;
    target.dispatchEvent(pointer("pointermove", 200, 200));
    expect(store.getState().cameraPose).toBe(start);
  });

  it("stops responding after dispose", () => {
    const { target, store, dispose } = setup();
    dispose();
    const start = store.getState().cameraPose;
    target.dispatchEvent(pointer("pointerdown", 0, 0));
    target.dispatchEvent(pointer("pointermove", 100, 100));
    target.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    expect(store.getState().cameraPose).toBe(start);
  });
});
