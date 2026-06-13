import type { RenderWorkerRequest } from "@render";
import { afterEach, describe, expect, it } from "vitest";
import { currentDevicePixelRatio, installViewportTracking } from "./viewportTracking.ts";

// installViewportTracking reads `ResizeObserver`/`matchMedia`/`window` as bare globals (browser-only);
// in node we stub them, capture the observer callback, and restore after each test.
const g = globalThis as unknown as Record<string, unknown>;
const original = { ResizeObserver: g.ResizeObserver, matchMedia: g.matchMedia, window: g.window };
afterEach(() => {
  g.ResizeObserver = original.ResizeObserver;
  g.matchMedia = original.matchMedia;
  g.window = original.window;
});

// A canvas with addEventListener present, so install takes the real path (not the headless no-op).
const liveCanvas = () => ({ addEventListener: () => {} }) as unknown as HTMLCanvasElement;

function stubObservers(dpr: number) {
  let cb: (() => void) | undefined;
  let disconnected = 0;
  g.window = { devicePixelRatio: dpr };
  g.ResizeObserver = class {
    constructor(callback: () => void) {
      cb = callback;
    }
    observe() {}
    disconnect() {
      disconnected += 1;
    }
  };
  g.matchMedia = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
  return { fire: () => cb?.(), disconnected: () => disconnected };
}

describe("currentDevicePixelRatio", () => {
  it("clamps to [1, 2]", () => {
    g.window = { devicePixelRatio: 3 };
    expect(currentDevicePixelRatio()).toBe(2);
    g.window = { devicePixelRatio: 1.5 };
    expect(currentDevicePixelRatio()).toBe(1.5);
    g.window = undefined;
    expect(currentDevicePixelRatio()).toBe(1);
  });
});

describe("installViewportTracking", () => {
  it("posts a resize on an observer fire, but only once ready", () => {
    const obs = stubObservers(2);
    const posts: RenderWorkerRequest[] = [];
    const worker = { postMessage: (m: RenderWorkerRequest) => posts.push(m) } as unknown as Worker;
    let ready = false;
    installViewportTracking({
      canvas: liveCanvas(),
      worker,
      isReady: () => ready,
      logicalSize: () => ({ width: 64, height: 48 }),
    });
    obs.fire();
    expect(posts).toHaveLength(0); // dropped pre-ready
    ready = true;
    obs.fire();
    const msg = posts[0];
    if (msg?.kind !== "resize") throw new Error("expected a single resize");
    expect([msg.width, msg.height, msg.devicePixelRatio]).toEqual([64, 48, 2]);
  });

  it("disconnects the observer on dispose", () => {
    const obs = stubObservers(1);
    const worker = { postMessage: () => {} } as unknown as Worker;
    const tracking = installViewportTracking({
      canvas: liveCanvas(),
      worker,
      isReady: () => true,
      logicalSize: () => ({ width: 10, height: 10 }),
    });
    tracking.dispose();
    expect(obs.disconnected()).toBe(1);
  });

  it("installs nothing for a canvas without addEventListener (headless)", () => {
    const worker = { postMessage: () => {} } as unknown as Worker;
    const tracking = installViewportTracking({
      canvas: {} as unknown as HTMLCanvasElement,
      worker,
      isReady: () => true,
      logicalSize: () => ({ width: 10, height: 10 }),
    });
    expect(() => tracking.dispose()).not.toThrow();
  });
});
