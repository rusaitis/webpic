import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { createSimulationStore, createUiStore } from "@store";
import { describe, expect, it } from "vitest";
import { installScreenshotBridge } from "./screenshotBridge.ts";

type ScreenshotReply = Extract<RenderWorkerResponse, { kind: "screenshot" }>;

function harness(ready = true) {
  const posts: RenderWorkerRequest[] = [];
  const worker = {
    postMessage: (message: RenderWorkerRequest) => posts.push(message),
  } as unknown as Worker;
  let isReady = ready;
  const store = createSimulationStore();
  const uiStore = createUiStore();
  const delivered: { blob: Blob; filename: string }[] = [];
  const bridge = installScreenshotBridge({
    store,
    uiStore,
    worker,
    isReady: () => isReady,
    deliver: (blob, filename) => delivered.push({ blob, filename }),
  });
  return { store, uiStore, posts, delivered, bridge, setReady: (v: boolean) => (isReady = v) };
}

function pngReply(blob: Blob | null): ScreenshotReply {
  return { kind: "screenshot", requestId: 15, blob, width: 4, height: 4 };
}

describe("installScreenshotBridge", () => {
  it("posts a capture request per serial bump while ready, silent before", () => {
    const { uiStore, posts, setReady } = harness(false);
    uiStore.getState().requestScreenshot();
    expect(posts).toHaveLength(0);
    setReady(true);
    uiStore.getState().requestScreenshot();
    expect(posts.map((p) => p.kind)).toEqual(["screenshot"]);
  });

  it("raises a loading pill on post and drops it on the reply", () => {
    const { uiStore, bridge } = harness();
    uiStore.getState().requestScreenshot();
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).toContain("screenshot");
    bridge.handleScreenshot(pngReply(new Blob(["png"], { type: "image/png" })));
    expect(uiStore.getState().loadingPhases).toHaveLength(0);
  });

  it("guards to one capture in flight; the reply re-arms it", () => {
    const { uiStore, posts, bridge } = harness();
    uiStore.getState().requestScreenshot();
    uiStore.getState().requestScreenshot(); // still in flight — dropped
    expect(posts).toHaveLength(1);
    bridge.handleScreenshot(pngReply(new Blob(["png"], { type: "image/png" })));
    uiStore.getState().requestScreenshot();
    expect(posts).toHaveLength(2);
  });

  it("delivers the blob under a sanitized dataset/step filename", () => {
    const { store, uiStore, bridge, delivered } = harness();
    uiStore.getState().requestScreenshot();
    const blob = new Blob(["png"], { type: "image/png" });
    bridge.handleScreenshot(pngReply(blob));
    const state = store.getState();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.blob).toBe(blob);
    expect(delivered[0]?.filename).toMatch(/^webpic-[\w.-]+-step\d+\.png$/);
    expect(delivered[0]?.filename).toContain(`step${state.currentStep}`);
  });

  it("ends the pill without delivering on a failed capture (blob null)", () => {
    const { uiStore, bridge, delivered } = harness();
    uiStore.getState().requestScreenshot();
    bridge.handleScreenshot(pngReply(null));
    expect(uiStore.getState().loadingPhases).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it("stops reacting after dispose", () => {
    const { uiStore, posts, bridge } = harness();
    bridge.dispose();
    uiStore.getState().requestScreenshot();
    expect(posts).toHaveLength(0);
  });
});
