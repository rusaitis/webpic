import type { RenderWorkerResponse } from "@render/messages.ts";
import { setLogSink } from "@schema/log.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CapturedLog, recordingSink } from "../../tests/helpers.ts";
import { routeWorkerResponse, type WorkerRouterHost } from "./_workerRouter.ts";

function makeHost(overrides: Partial<WorkerRouterHost> = {}) {
  const setFrameTiming = vi.fn();
  const host = {
    uiStore: { getState: () => ({}) },
    perfStore: { getState: () => ({ setFrameTiming }) },
    endBootPhase: vi.fn(),
    isWorkerReady: () => true,
    onReady: vi.fn(),
    ingestRenderSample: vi.fn(),
    applyPickResult: vi.fn(),
    finishLayerLoading: vi.fn(),
    deliverScreenshot: vi.fn(),
    onDisposed: vi.fn(),
    ...overrides,
  } as unknown as WorkerRouterHost;
  return { host, setFrameTiming };
}

const route = (message: unknown, host: WorkerRouterHost): void =>
  routeWorkerResponse(message as RenderWorkerResponse, host);

describe("routeWorkerResponse", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("hands each reply to the seam that owns it", () => {
    const { host, setFrameTiming } = makeHost();
    route({ kind: "ready", requestId: 1 }, host);
    route({ kind: "frameTiming", requestId: 2, gpuTimeMs: 7, clock: "wallclock" }, host);
    route({ kind: "perfSample", requestId: 3 }, host);
    route({ kind: "pickResult", requestId: 4 }, host);
    route({ kind: "layerCompiled", requestId: 5, id: "layer-0" }, host);
    route({ kind: "screenshot", requestId: 6, blob: null }, host);
    route({ kind: "disposed", requestId: 7 }, host);

    expect(host.onReady).toHaveBeenCalledOnce();
    expect(setFrameTiming).toHaveBeenCalledWith(7, "wallclock");
    expect(host.ingestRenderSample).toHaveBeenCalledOnce();
    expect(host.applyPickResult).toHaveBeenCalledOnce();
    expect(host.finishLayerLoading).toHaveBeenCalledOnce();
    expect(host.deliverScreenshot).toHaveBeenCalledOnce();
    expect(host.onDisposed).toHaveBeenCalledOnce();
  });

  it("ignores the headless readback reply — screenshots ride their own message", () => {
    const { host } = makeHost();
    route({ kind: "frame", requestId: 1, width: 2, height: 2, pixels: new ArrayBuffer(16) }, host);
    expect(host.deliverScreenshot).not.toHaveBeenCalled();
  });

  it("banners a pre-first-frame error, because the status pill auto-clears", () => {
    const { host } = makeHost({ isWorkerReady: () => false });
    route({ kind: "error", requestId: -1, message: "no adapter" }, host);
    expect(host.endBootPhase).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("could not start the WebGPU renderer");
  });

  it("leaves a post-first-frame error to the log — the canvas still shows its last frame", () => {
    const { host } = makeHost({ isWorkerReady: () => true });
    route({ kind: "error", requestId: -1, message: "transient" }, host);
    expect(host.endBootPhase).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });

  it("banners an unrecoverable GPU loss whether or not the first frame landed", () => {
    const { host } = makeHost({ isWorkerReady: () => true });
    route({ kind: "gpuRecoveryFailed", requestId: -1, reason: "breaker", message: "gone" }, host);
    expect(host.endBootPhase).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("could not recover");
  });

  it("logs an unknown kind instead of throwing at the never-arm", () => {
    const { host } = makeHost();
    const captured: CapturedLog[] = [];
    setLogSink(recordingSink(captured));
    route({ kind: "nonsense", requestId: 0 }, host);
    setLogSink(null);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.level).toBe("error");
    expect(JSON.stringify(captured[0]?.detail ?? captured[0]?.message)).toContain("nonsense");
  });
});
