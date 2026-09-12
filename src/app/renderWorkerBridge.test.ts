import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { createPerfStore, createSimulationStore } from "@store";
import { describe, expect, it } from "vitest";
import { installRenderWorkerBridge } from "./renderWorkerBridge.ts";

function harness(ready: boolean) {
  const posts: RenderWorkerRequest[] = [];
  const worker = {
    postMessage: (message: RenderWorkerRequest) => posts.push(message),
  } as unknown as Worker;
  let isReady = ready;
  const store = createSimulationStore();
  const perfStore = createPerfStore();
  const sync = installRenderWorkerBridge({ store, perfStore, worker, isReady: () => isReady });
  return { store, perfStore, posts, sync, setReady: (v: boolean) => (isReady = v) };
}

describe("installRenderWorkerBridge", () => {
  it("stays silent until the worker is ready", () => {
    const { store, perfStore, posts } = harness(false);
    store.getState().setCameraPose({ ...store.getState().cameraPose });
    store.getState().setProjection("orthographic");
    store.getState().setCameraMotion("gesture");
    perfStore.getState().setMeasuringContinuous(true);
    expect(posts).toHaveLength(0);
  });

  it("posts pose / projection / motion / continuous on change while ready", () => {
    const { store, perfStore, posts } = harness(true);
    store.getState().setCameraPose({ ...store.getState().cameraPose });
    store.getState().setProjection("orthographic");
    store.getState().setCameraMotion("gesture");
    perfStore.getState().setMeasuringContinuous(true);
    expect(posts.map((p) => p.kind)).toEqual([
      "setCameraPose",
      "setProjection",
      "setCameraMotion",
      "setContinuous",
    ]);
  });

  it("flushAll posts the live pose, and projection only when non-perspective", () => {
    const { posts, sync } = harness(true);
    sync.flushAll(); // default projection is perspective
    expect(posts.map((p) => p.kind)).toEqual(["setCameraPose"]);
  });

  it("flushAll replays a non-default projection (the ?proj=ortho catch-up)", () => {
    const { store, posts, sync, setReady } = harness(false);
    store.getState().setProjection("orthographic"); // dropped pre-ready
    setReady(true);
    posts.length = 0;
    sync.flushAll();
    expect(posts.map((p) => p.kind)).toEqual(["setCameraPose", "setProjection"]);
  });

  it("forwards a ready pick request as a pickRay and consumes it", () => {
    const { store, posts } = harness(true);
    store.getState().requestPick({ ndcX: 0, ndcY: 0, aspect: 1, purpose: "place" });
    const pick = posts.find((p) => p.kind === "pickRay");
    expect(pick?.kind).toBe("pickRay");
    expect(store.getState().pickRequest).toBeNull(); // consumed — same-spot clicks re-fire
  });

  it("falls back to a geometric focus fly when not ready (no worker round-trip)", () => {
    const { store, posts } = harness(false);
    store.getState().requestPick({
      ndcX: 0,
      ndcY: 0,
      aspect: 1,
      purpose: "focus",
      focusDistance: 1.5,
    });
    expect(posts.find((p) => p.kind === "pickRay")).toBeUndefined(); // no worker march pre-ready
    const fly = store.getState().cameraFlyRequest;
    if (fly === null || fly.target.kind !== "pose") throw new Error("expected a pose fly request");
    expect(store.getState().pickRequest).toBeNull(); // still consumed
  });

  it("applyPickResult places the marker and retargets a focus fly", () => {
    const { store, sync } = harness(true);
    sync.applyPickResult({
      kind: "pickResult",
      requestId: 10,
      point: [0.1, 0.2, 0.3],
      purpose: "focus",
      focusDistance: 1.5,
    } satisfies Extract<RenderWorkerResponse, { kind: "pickResult" }>);
    expect(store.getState().pickerPoint).toEqual([0.1, 0.2, 0.3]);
    expect(store.getState().cameraFlyRequest?.target.kind).toBe("pose");
  });

  it("applyPickResult ignores a missed ray (null point)", () => {
    const { store, sync } = harness(true);
    const before = store.getState().pickerPoint;
    sync.applyPickResult({
      kind: "pickResult",
      requestId: 10,
      point: null,
      purpose: "place",
    } satisfies Extract<RenderWorkerResponse, { kind: "pickResult" }>);
    expect(store.getState().pickerPoint).toBe(before);
    expect(store.getState().cameraFlyRequest).toBeNull();
  });

  it("stops posting after dispose", () => {
    const { store, posts, sync } = harness(true);
    sync.dispose();
    store.getState().setCameraPose({ ...store.getState().cameraPose });
    expect(posts).toHaveLength(0);
  });
});
