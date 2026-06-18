import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderLoop, type RenderLoopHost } from "./renderLoop.ts";

// The loop in isolation: a manually pumped rAF stub stands in for the browser's vsync, and a fake
// host counts paints / quality advances / faults. These pin the orderings the through-the-worker
// suites depend on (reschedule-first, advance-after-paint, readback pause) without a real renderer.
let rafCallbacks: FrameRequestCallback[] = [];

function pumpFrame(timeMs = 0): void {
  const due = rafCallbacks.splice(0); // renderTick reschedules itself, so snapshot first
  for (const cb of due) cb(timeMs);
}

function harness(over: Partial<RenderLoopHost> = {}) {
  const host = {
    hasRenderer: vi.fn(() => true),
    isDeviceLost: vi.fn(() => false),
    paint: vi.fn(),
    paintTimed: vi.fn(),
    paintPerf: vi.fn(),
    tickAnimations: vi.fn(() => false),
    advanceQuality: vi.fn(),
    sampleFrameInterval: vi.fn(),
    reportFault: vi.fn(),
    clearError: vi.fn(),
    ...over,
  };
  const loop = createRenderLoop(host);
  return { loop, host };
}

beforeEach(() => {
  rafCallbacks = [];
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (): void => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRenderLoop", () => {
  it("paints on demand: a requested frame paints once, idle frames don't", () => {
    const { loop, host } = harness();
    loop.start();
    pumpFrame(); // reschedules; nothing dirty → no paint
    expect(host.paint).not.toHaveBeenCalled();
    loop.requestRender(); // a running loop just sets the dirty flag, no synchronous paint
    expect(host.paint).not.toHaveBeenCalled();
    pumpFrame();
    expect(host.paint).toHaveBeenCalledTimes(1);
    pumpFrame(); // dirty cleared → quiet
    expect(host.paint).toHaveBeenCalledTimes(1);
  });

  it("continuous mode paints every frame via the timed path", () => {
    const { loop, host } = harness();
    loop.start();
    loop.setContinuous(true);
    pumpFrame();
    pumpFrame();
    expect(host.paintTimed).toHaveBeenCalledTimes(2);
    expect(host.paint).not.toHaveBeenCalled();
  });

  it("a readback pause suppresses the loop's paint; ending it re-dirties", () => {
    const { loop, host } = harness();
    loop.start();
    loop.requestRender();
    loop.beginReadback();
    pumpFrame(); // readback in flight → early return
    expect(host.paint).not.toHaveBeenCalled();
    loop.endReadback();
    pumpFrame();
    expect(host.paint).toHaveBeenCalledTimes(1);
  });

  it("in Node (no rAF), requestRender paints synchronously and start is a no-op", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const { loop, host } = harness();
    loop.start();
    expect(loop.isRunning()).toBe(false);
    loop.requestRender();
    expect(host.paint).toHaveBeenCalledTimes(1);
  });

  it("a throwing paint still reschedules — the loop survives the bad frame", () => {
    const { loop, host } = harness({
      paint: vi.fn(() => {
        throw new Error("bad frame");
      }),
    });
    loop.start();
    loop.requestRender();
    pumpFrame();
    expect(host.reportFault).toHaveBeenCalledTimes(1);
    expect(rafCallbacks.length).toBe(1); // rescheduled despite the throw
  });

  it("marker easing keeps the on-demand loop painting without a requestRender", () => {
    const { loop, host } = harness({ tickAnimations: vi.fn(() => true) });
    loop.start();
    pumpFrame();
    expect(host.paint).toHaveBeenCalledTimes(1);
    pumpFrame();
    expect(host.paint).toHaveBeenCalledTimes(2); // still animating → keeps painting
  });

  it("advanceQuality runs after each painted on-demand frame, not on idle frames", () => {
    const { loop, host } = harness();
    loop.start();
    loop.requestRender();
    pumpFrame();
    expect(host.advanceQuality).toHaveBeenCalledTimes(1);
    pumpFrame();
    expect(host.advanceQuality).toHaveBeenCalledTimes(1);
  });

  it("a synchronous requestRender is gated on renderer + live device", () => {
    const noRenderer = harness({ hasRenderer: vi.fn(() => false) });
    noRenderer.loop.requestRender();
    expect(noRenderer.host.paint).not.toHaveBeenCalled();

    const lost = harness({ isDeviceLost: vi.fn(() => true) });
    lost.loop.requestRender();
    expect(lost.host.paint).not.toHaveBeenCalled();

    const ready = harness();
    ready.loop.requestRender();
    expect(ready.host.paint).toHaveBeenCalledTimes(1);
  });

  it("stop ends the loop; start is idempotent", () => {
    const { loop } = harness();
    loop.start();
    expect(loop.isRunning()).toBe(true);
    const scheduled = rafCallbacks.length;
    loop.start();
    expect(rafCallbacks.length).toBe(scheduled); // no double schedule
    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });
});
