import { createSimulationStore, DEFAULT_POSE, dollyPose } from "@store";
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

// Pump glide frames until the predicate holds (tweens run on real elapsed time, ~450 ms).
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

  it("normalizes line-mode wheel deltas to OrbitControls' pixel feel (×16)", () => {
    const a = setup();
    const b = setup();
    // Firefox line-mode notch (deltaY ≈ 3) must dolly exactly like a 48-pixel Chrome delta.
    a.target.dispatchEvent(new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, cancelable: true }));
    b.target.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -48, deltaMode: 0, cancelable: true }),
    );
    expect(a.store.getState().cameraPose.distance).toBeCloseTo(
      b.store.getState().cameraPose.distance,
      12,
    );
  });

  it("boosts ctrl-wheel trackpad pinches ×10", () => {
    const a = setup();
    const b = setup();
    const pinch = new WheelEvent("wheel", { deltaY: -12 });
    // happy-dom's WheelEvent drops MouseEventInit modifiers; pin ctrlKey on the instance.
    Object.defineProperty(pinch, "ctrlKey", { value: true });
    a.target.dispatchEvent(pinch);
    b.target.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    expect(a.store.getState().cameraPose.distance).toBeCloseTo(
      b.store.getState().cameraPose.distance,
      12,
    );
  });

  it("bridges Safari GestureEvents to the dolly path when the browser supports them", () => {
    // Simulate Safari: the bridge feature-detects GestureEvent on the window before listening.
    (window as unknown as Record<string, unknown>).GestureEvent = class extends Event {};
    try {
      const { target, store } = setup();
      const start = store.getState().cameraPose;
      target.dispatchEvent(new Event("gesturestart", { cancelable: true }));
      const change = new Event("gesturechange", { cancelable: true });
      Object.defineProperty(change, "scale", { value: 1.5 }); // pinch out = zoom in
      expect(target.dispatchEvent(change)).toBe(false); // preventDefault'ed — no page zoom
      expect(store.getState().cameraPose.distance).toBeLessThan(start.distance);
    } finally {
      delete (window as unknown as Record<string, unknown>).GestureEvent;
    }
  });

  it("ignores GestureEvents when the browser lacks them (no Safari)", () => {
    const { target, store } = setup();
    const start = store.getState().cameraPose;
    target.dispatchEvent(new Event("gesturestart", { cancelable: true }));
    const change = new Event("gesturechange", { cancelable: true });
    Object.defineProperty(change, "scale", { value: 1.5 });
    target.dispatchEvent(change);
    expect(store.getState().cameraPose).toBe(start); // no listeners attached
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

  it("double-click without layout flies back to the default pose (reset fallback)", async () => {
    const { target, store } = setup();
    target.dispatchEvent(pointer("pointerdown", 100, 100));
    target.dispatchEvent(pointer("pointermove", 260, 170));
    target.dispatchEvent(pointer("pointerup", 260, 170));
    await pumpUntil(() => store.getState().cameraMotion === "idle"); // glide out
    expect(store.getState().cameraPose).not.toBe(DEFAULT_POSE);
    // happy-dom's zero rect = no cursor to pick with — the gesture degrades to the old reset.
    target.dispatchEvent(new MouseEvent("dblclick"));
    // The tween's final frame applies the exact target object.
    await pumpUntil(() => store.getState().cameraPose === DEFAULT_POSE);
  });

  it("double-click on the box flies immediately and dispatches a pick intent with the goal distance", async () => {
    const { target, store } = setup();
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const start = store.getState().cameraPose;
    // Center of the frame: the default pose looks at the box center, so the ray hits.
    target.dispatchEvent(new MouseEvent("dblclick", { clientX: 100, clientY: 50 }));
    expect(store.getState().pickRequest).toEqual({
      ndcX: 0,
      ndcY: 0,
      aspect: 2,
      purpose: "focus",
      focusDistance: start.distance * 0.7, // committed once, before the flight moves the pose
    });
    // The flight toward the chord midpoint starts without waiting for any pick result.
    await pumpUntil(() => store.getState().cameraPose.distance < start.distance * 0.9);
  });

  it("double-click off the box resets instead of picking", async () => {
    const { target, store } = setup();
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    store.getState().setCameraPose({ ...DEFAULT_POSE, azimuth: 2 });
    // Top-left frame corner: NDC (−1, +1) clears the unit box from the default-distance view.
    target.dispatchEvent(new MouseEvent("dblclick", { clientX: 0, clientY: 0 }));
    expect(store.getState().pickRequest).toBeNull();
    await pumpUntil(() => store.getState().cameraPose === DEFAULT_POSE);
  });

  it("ignores a modified double-click", async () => {
    const { target, store } = setup();
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const moved = { ...DEFAULT_POSE, azimuth: 2 };
    store.getState().setCameraPose(moved);
    target.dispatchEvent(new MouseEvent("dblclick", { clientX: 100, clientY: 50, shiftKey: true }));
    await frame();
    expect(store.getState().pickRequest).toBeNull();
    expect(store.getState().cameraPose).toBe(moved);
  });

  it("the R key flies back to the default pose", async () => {
    const { store } = setup();
    store.getState().setCameraPose({ ...DEFAULT_POSE, azimuth: 2, distance: 5 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    await pumpUntil(() => store.getState().cameraPose === DEFAULT_POSE);
  });

  it("ignores R with shift held or while typing in a contenteditable host", async () => {
    const { store } = setup();
    const moved = { ...DEFAULT_POSE, azimuth: 2, distance: 5 };
    store.getState().setCameraPose(moved);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "R", shiftKey: true }));
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.appendChild(editor);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    await frame();
    await frame();
    expect(store.getState().cameraPose).toBe(moved); // neither fired a fly-to
  });

  it("a drag blends with an in-flight fly-to instead of canceling it", async () => {
    const { target, store } = setup();
    store.getState().setCameraPose({ ...DEFAULT_POSE, azimuth: 2.5 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    await frame(); // tween underway
    target.dispatchEvent(pointer("pointerdown", 100, 100));
    target.dispatchEvent(pointer("pointermove", 100, 160)); // vertical drag — elevation only
    target.dispatchEvent(pointer("pointerup", 100, 160));
    await pumpUntil(() => store.getState().cameraMotion === "idle"); // flight + glide both land
    const pose = store.getState().cameraPose;
    expect(pose.azimuth).toBeCloseTo(DEFAULT_POSE.azimuth, 6); // the flight still landed
    expect(pose.elevation).toBeGreaterThan(DEFAULT_POSE.elevation + 0.3); // the drag survived
    expect(pose.distance).toBeCloseTo(DEFAULT_POSE.distance, 12);
  });

  it("a wheel dolly composes with an in-flight fly-to (log-additive distance)", async () => {
    const { target, store } = setup();
    const to = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 2 } as const;
    store.getState().requestCameraFly({ kind: "pose", pose: to });
    await frame(); // flight underway
    target.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
    await pumpUntil(() => store.getState().cameraMotion === "idle");
    const pose = store.getState().cameraPose;
    // The wheel's geometric factor rides on the flight's goal distance — neither motion is lost.
    expect(pose.distance).toBeCloseTo(dollyPose(to, 120).distance, 9);
    expect(pose.azimuth).toBeCloseTo(to.azimuth, 9);
    for (let i = 0; i < 3; i++) expect(pose.target[i]).toBeCloseTo(to.target[i] ?? Number.NaN, 9);
  });

  it("consumes cameraFlyRequest intents (gnomon snaps)", async () => {
    const { store } = setup();
    const to = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 2 } as const;
    store.getState().requestCameraFly({ kind: "pose", pose: to });
    expect(store.getState().cameraFlyRequest).toBeNull(); // consumed synchronously
    await pumpUntil(() => store.getState().cameraPose === to);
  });

  it("resolves a fit fly request against the canvas aspect and tweens there", async () => {
    const { target, store } = setup();
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200 }) as DOMRect;
    const start = store.getState().cameraPose;
    store.getState().requestCameraFly({ kind: "fit" });
    expect(store.getState().cameraFlyRequest).toBeNull(); // consumed synchronously
    await pumpUntil(() => store.getState().cameraPose.distance !== start.distance);
    await pumpUntil(() => store.getState().cameraMotion === "idle"); // tween lands
    const pose = store.getState().cameraPose;
    expect(pose.azimuth).toBe(start.azimuth); // fit keeps the viewing direction
    expect(pose.elevation).toBe(start.elevation);
    expect(pose.target).toEqual([0, 0, 0]);
  });

  it("the Z key fits the data", async () => {
    const { store } = setup();
    store.getState().setCameraPose({ ...DEFAULT_POSE, distance: 40 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
    await pumpUntil(() => store.getState().cameraPose.distance < 5);
  });

  it("held arrow keys orbit at constant velocity until released", async () => {
    const { store } = setup();
    const start = store.getState().cameraPose;
    const down = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      code: "ArrowRight",
      cancelable: true,
    });
    expect(document.dispatchEvent(down)).toBe(false); // preventDefault'ed — no page scroll
    expect(store.getState().cameraMotion).toBe("gesture");
    await frame();
    const early = store.getState().cameraPose;
    expect(early.azimuth).toBeLessThan(start.azimuth); // arrow right ≙ drag right
    await frame();
    expect(store.getState().cameraPose.azimuth).toBeLessThan(early.azimuth); // still moving
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", code: "ArrowRight" }));
    await pumpUntil(() => store.getState().cameraMotion === "idle"); // hard stop, no glide tail
  });

  it("the -/= keys dolly out and in", async () => {
    const { store } = setup();
    const start = store.getState().cameraPose.distance;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "=", code: "Equal" }));
    await frame();
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "=", code: "Equal" }));
    const zoomedIn = store.getState().cameraPose.distance;
    expect(zoomedIn).toBeLessThan(start);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "-", code: "Minus" }));
    await frame();
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "-", code: "Minus" }));
    expect(store.getState().cameraPose.distance).toBeGreaterThan(zoomedIn);
  });

  it("releases a dolly key even when Shift renamed it between keydown and keyup", async () => {
    const { store } = setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "=", code: "Equal" }));
    await frame();
    // Shift pressed mid-hold (reaching for the pan modifier): the keyup arrives as "+", but the
    // held set is keyed by code, so the physical key still releases — no runaway zoom.
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "+", code: "Equal", shiftKey: true }));
    await pumpUntil(() => store.getState().cameraMotion === "idle");
  });

  it("drops held keys when a modifier chord starts (macOS swallows those keyups)", async () => {
    const { store } = setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp" }));
    expect(store.getState().cameraMotion).toBe("gesture");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Meta", code: "MetaLeft", metaKey: true }),
    );
    await pumpUntil(() => store.getState().cameraMotion === "idle");
  });

  it("clears held keys when the window blurs (no stuck motion)", async () => {
    const { store } = setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp" }));
    expect(store.getState().cameraMotion).toBe("gesture");
    window.dispatchEvent(new Event("blur"));
    await pumpUntil(() => store.getState().cameraMotion === "idle");
  });

  it("tracks motion liveness in cameraMotion", async () => {
    const { target, store } = setup();
    expect(store.getState().cameraMotion).toBe("idle");
    target.dispatchEvent(pointer("pointerdown", 100, 100));
    expect(store.getState().cameraMotion).toBe("gesture");
    target.dispatchEvent(pointer("pointermove", 140, 100));
    target.dispatchEvent(pointer("pointerup", 140, 100));
    await pumpUntil(() => store.getState().cameraMotion === "idle"); // idle once the glide settles
  });

  it("reports a lone tween as 'fly' and hand input during it as 'gesture'", async () => {
    const { store } = setup();
    store.getState().setCameraPose({ ...DEFAULT_POSE, azimuth: 2.5 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    expect(store.getState().cameraMotion).toBe("fly"); // machine flight, hand off the camera
    await frame();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", cancelable: true }),
    );
    expect(store.getState().cameraMotion).toBe("gesture"); // real input outranks the fly
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", code: "ArrowUp" }));
    await frame();
    await frame();
    expect(store.getState().cameraMotion).toBe("fly"); // key released mid-flight → back to fly
    await pumpUntil(() => store.getState().cameraMotion === "idle"); // flight lands
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
