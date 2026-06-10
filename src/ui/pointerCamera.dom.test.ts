import { createSimulationStore, DEFAULT_POSE } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installPointerCamera } from "./pointerCamera.ts";

// happy-dom: pointer/wheel events drive the orbit-pose intents. We assert the dispatched pose,
// not pixels — the render worker is out of scope here. Drags are damped: deltas accumulate as
// momentum a rAF glide loop releases, so drag tests pump a frame before asserting direction.

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

// One glide frame: the loop's rAF is scheduled before this one, so it has run when this resolves.
function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Pump glide frames until the predicate holds (tweens run on real elapsed time, ~400 ms).
async function pumpUntil(predicate: () => boolean, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("pumpUntil timed out");
    await frame();
  }
}

describe("installPointerCamera", () => {
  it("orbits on left-drag: horizontal spins azimuth, vertical tilts elevation", async () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;

    target.dispatchEvent(pointer("pointerdown", 100, 100));
    target.dispatchEvent(pointer("pointermove", 160, 100)); // drag right
    await frame();
    const afterX = store.getState().cameraPose;
    expect(afterX.azimuth).toBeLessThan(start.azimuth);
    expect(afterX.elevation).toBeCloseTo(start.elevation, 12);
    expect(afterX.target).toBe(start.target); // orbit never moves the target

    target.dispatchEvent(pointer("pointermove", 160, 140)); // then drag down
    await frame();
    expect(store.getState().cameraPose.elevation).toBeGreaterThan(afterX.elevation); // down ⇒ rises
  });

  it("keeps gliding after release and settles", async () => {
    const { target, store } = setup();
    target.dispatchEvent(pointer("pointerdown", 100, 100));
    target.dispatchEvent(pointer("pointermove", 220, 100));
    target.dispatchEvent(pointer("pointerup", 220, 100));
    await frame();
    const early = store.getState().cameraPose;
    await frame();
    await frame();
    // Momentum persists past pointerup: the pose keeps moving the same way.
    expect(store.getState().cameraPose.azimuth).toBeLessThan(early.azimuth);
  });

  it("pans on shift-drag: only the target moves", async () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;

    target.dispatchEvent(pointer("pointerdown", 50, 50, { shiftKey: true }));
    target.dispatchEvent(pointer("pointermove", 90, 80, { shiftKey: true }));
    await frame();

    const pose = store.getState().cameraPose;
    expect(pose.azimuth).toBe(start.azimuth);
    expect(pose.elevation).toBe(start.elevation);
    expect(pose.distance).toBe(start.distance);
    expect(pose.target).not.toEqual(start.target);
  });

  it("dollies on wheel: scroll up zooms in (distance shrinks)", () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;
    // happy-dom lays nothing out (zero rect) — this exercises the plain-dolly fallback.
    target.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true }));
    expect(store.getState().cameraPose.distance).toBeLessThan(start.distance);
  });

  it("anchors wheel zoom to the cursor when the target has layout", () => {
    const { target, store } = setup();
    // happy-dom has no layout engine; stub the rect the wheel handler reads its NDC from.
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const start = store.getState().cameraPose;
    const wheel = new WheelEvent("wheel", { deltaY: -120 });
    // happy-dom's WheelEvent drops MouseEventInit coordinates; pin them on the instance.
    Object.defineProperty(wheel, "clientX", { value: 180 });
    Object.defineProperty(wheel, "clientY", { value: 50 });
    target.dispatchEvent(wheel);
    const pose = store.getState().cameraPose;
    expect(pose.distance).toBeLessThan(start.distance);
    // Cursor on the right half (ndcX 0.8, ndcY 0) pulls the target along screenRight = (−sa, ca, 0):
    // default azimuth π/4 ⇒ x decreases, y increases, z holds.
    expect(pose.target[0]).toBeLessThan(start.target[0]);
    expect(pose.target[1]).toBeGreaterThan(start.target[1]);
    expect(pose.target[2]).toBeCloseTo(start.target[2], 12);
  });

  it("ignores moves with no active drag", async () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;
    target.dispatchEvent(pointer("pointermove", 200, 200));
    await frame();
    expect(store.getState().cameraPose).toBe(start);
  });

  it("stops responding after dispose, cancelling an in-flight glide", async () => {
    const { target, store, dispose } = setup();
    target.dispatchEvent(pointer("pointerdown", 0, 0));
    target.dispatchEvent(pointer("pointermove", 100, 100));
    await frame();
    dispose();
    const atDispose = store.getState().cameraPose;
    target.dispatchEvent(pointer("pointermove", 300, 300));
    target.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    await frame();
    await frame();
    expect(store.getState().cameraPose).toBe(atDispose); // glide cancelled, listeners gone
  });

  it("pans on right-drag and suppresses the context menu", async () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;
    target.dispatchEvent(pointer("pointerdown", 50, 50, { button: 2 }));
    target.dispatchEvent(pointer("pointermove", 90, 80));
    await frame();
    const pose = store.getState().cameraPose;
    expect(pose.azimuth).toBe(start.azimuth);
    expect(pose.target).not.toEqual(start.target);
    // The pan owns the right button — the browser menu must not open over it.
    const menu = new MouseEvent("contextmenu", { cancelable: true });
    expect(target.dispatchEvent(menu)).toBe(false); // preventDefault'ed
  });

  it("two-pointer pinch dollies immediately and pans by the centroid translation", async () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;
    target.dispatchEvent(pointer("pointerdown", 100, 100, { pointerId: 1 }));
    target.dispatchEvent(pointer("pointerdown", 200, 100, { pointerId: 2 }));
    // Spread 100 → 180 while the centroid slides right 40 px: zoom-in + two-finger pan.
    target.dispatchEvent(pointer("pointermove", 280, 100, { pointerId: 2 }));
    const pinched = store.getState().cameraPose;
    expect(pinched.distance).toBeLessThan(start.distance); // dolly is immediate (wheel parity)
    expect(pinched.azimuth).toBe(start.azimuth); // a pinch never orbits
    await frame();
    expect(store.getState().cameraPose.target).not.toEqual(start.target); // damped centroid pan
  });

  it("falls back to a clean single-pointer drag when one finger lifts", async () => {
    const { target, store } = setup();
    target.dispatchEvent(pointer("pointerdown", 100, 100, { pointerId: 1 }));
    target.dispatchEvent(pointer("pointerdown", 200, 100, { pointerId: 2 }));
    target.dispatchEvent(pointer("pointerup", 200, 100, { pointerId: 2 }));
    const before = store.getState().cameraPose;
    target.dispatchEvent(pointer("pointermove", 160, 100, { pointerId: 1 })); // drag right
    await frame();
    expect(store.getState().cameraPose.azimuth).toBeLessThan(before.azimuth); // orbit, no jump
  });

  it("double-click flies the camera back to the default pose", async () => {
    const { target, store } = setup();
    target.dispatchEvent(pointer("pointerdown", 100, 100));
    target.dispatchEvent(pointer("pointermove", 260, 170));
    target.dispatchEvent(pointer("pointerup", 260, 170));
    await pumpUntil(() => !store.getState().isCameraInteracting); // glide out
    expect(store.getState().cameraPose).not.toBe(DEFAULT_POSE);
    target.dispatchEvent(new MouseEvent("dblclick"));
    // The tween's final frame applies the exact target object.
    await pumpUntil(() => store.getState().cameraPose === DEFAULT_POSE);
  });

  it("the R key flies back to the default pose", async () => {
    const { store } = setup();
    store.getState().setCameraPose({ ...DEFAULT_POSE, azimuth: 2, distance: 5 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    await pumpUntil(() => store.getState().cameraPose === DEFAULT_POSE);
  });

  it("pointer input interrupts an in-flight fly-to", async () => {
    const { target, store } = setup();
    store.getState().setCameraPose({ ...DEFAULT_POSE, azimuth: 2.5 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    await frame(); // tween underway
    target.dispatchEvent(pointer("pointerdown", 100, 100)); // user takes over
    const at = store.getState().cameraPose;
    await frame();
    await frame();
    expect(store.getState().cameraPose).toBe(at); // tween dead, no drift
    expect(at).not.toBe(DEFAULT_POSE);
  });

  it("consumes cameraFlyRequest intents (gnomon snaps)", async () => {
    const { store } = setup();
    const to = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 2 } as const;
    store.getState().requestCameraFly(to);
    expect(store.getState().cameraFlyRequest).toBeNull(); // consumed synchronously
    await pumpUntil(() => store.getState().cameraPose === to);
  });

  it("tracks gesture liveness in isCameraInteracting", async () => {
    const { target, store } = setup();
    expect(store.getState().isCameraInteracting).toBe(false);
    target.dispatchEvent(pointer("pointerdown", 100, 100));
    expect(store.getState().isCameraInteracting).toBe(true);
    target.dispatchEvent(pointer("pointermove", 140, 100));
    target.dispatchEvent(pointer("pointerup", 140, 100));
    await pumpUntil(() => !store.getState().isCameraInteracting); // false once the glide settles
  });

  it("shows grab/grabbing cursors and restores the prior cursor on dispose", () => {
    const { target, dispose } = setup();
    expect(target.style.cursor).toBe("grab");
    target.dispatchEvent(pointer("pointerdown", 0, 0));
    expect(target.style.cursor).toBe("grabbing");
    target.dispatchEvent(pointer("pointerup", 0, 0));
    expect(target.style.cursor).toBe("grab");
    dispose();
    expect(target.style.cursor).toBe("");
  });
});
