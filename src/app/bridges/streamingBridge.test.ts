import { type DataStreamRequest, type DataStreamResponse, syntheticHandle } from "@data";
import type { RenderWorkerRequest } from "@render/messages.ts";
import { createSimulationStore, createUiStore } from "@store";
import { describe, expect, it, vi } from "vitest";
import { makeFakeWorker, vectorTriple } from "../../../tests/fixtures.ts";
import { flushAsync } from "../../../tests/helpers.ts";
import { installStreamingBridge } from "./streamingBridge.ts";

async function harness() {
  const { worker: dataWorker, posts: dataPosts, terminated } = makeFakeWorker<DataStreamRequest>();
  const { worker: renderWorker, posts: renderPosts } = makeFakeWorker<RenderWorkerRequest>();

  const store = createSimulationStore();
  const uiStore = createUiStore();
  store.getState().setDataset(vectorTriple("B")); // seeds one layer → selectedLayerId non-null
  await flushAsync(); // the seed recompute is async — settle it before the bridge reads the layer
  const bridge = installStreamingBridge({
    store,
    uiStore,
    renderWorker,
    dataWorker,
    streamSource: syntheticHandle(8, 4),
  });
  const emit = (message: DataStreamResponse) =>
    dataWorker.onmessage?.({ data: message } as MessageEvent<DataStreamResponse>);
  return {
    store,
    uiStore,
    bridge,
    dataPosts,
    renderPosts,
    emit,
    terminated,
  };
}

describe("installStreamingBridge", () => {
  it("posts nothing to the data worker before open()", async () => {
    const { store, bridge, dataPosts } = await harness();
    store.getState().selectField("B_1"); // activeField change, but the worker has no reader yet
    expect(dataPosts).toHaveLength(0);
    bridge.dispose();
  });

  it("open posts the open message with the seeded layer and a transferred port", async () => {
    const { store, bridge, dataPosts } = await harness();
    bridge.open();
    const open = dataPosts.find((p) => p.message.kind === "open");
    if (open === undefined || open.message.kind !== "open") throw new Error("expected open");
    expect(open.message.activeField).toBe("|B|");
    expect(open.message.layerId).toBe(store.getState().selectedLayerId);
    expect(open.transfer).toHaveLength(1); // the data-side MessagePort, transferred
    bridge.dispose();
  });

  it("pair posts the streaming port into the render worker (transferred)", async () => {
    const { bridge, renderPosts } = await harness();
    bridge.pair();
    const pair = renderPosts.find((p) => p.message.kind === "pair");
    expect(pair?.message.kind).toBe("pair");
    expect(pair?.transfer).toHaveLength(1);
    bridge.dispose();
  });

  it("relays the opened domain and drives the cursor, ignoring a stale step ack", async () => {
    const { store, uiStore, bridge, dataPosts, emit } = await harness();
    bridge.open();
    emit({ kind: "opened", steps: [0, 1, 2, 3] });
    expect(store.getState().availableSteps).toEqual([0, 1, 2, 3]);

    store.getState().setStep(2);
    const cursor = dataPosts.find((p) => p.message.kind === "setCursor");
    if (cursor?.message.kind !== "setCursor") throw new Error("expected setCursor");
    expect(cursor.message.step).toBe(2);
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).toContain("step");

    emit({ kind: "stepLoaded", step: 1 }); // stale — must not end the newer load
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).toContain("step");
    emit({ kind: "stepLoaded", step: 2 });
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).not.toContain("step");
    bridge.dispose();
  });

  it("re-streams a field switch only after a first scrub", async () => {
    const { store, uiStore, bridge, dataPosts, emit } = await harness();
    bridge.open();
    emit({ kind: "opened", steps: [0, 1, 2, 3] });

    store.getState().selectField("B_1"); // pre-scrub: posts, but no loading phase (worker never acks)
    expect(dataPosts.some((p) => p.message.kind === "setActiveField")).toBe(true);
    expect(uiStore.getState().loadingPhases.map((p) => p.key)).not.toContain("step");

    store.getState().setStep(2); // first scrub
    store.getState().selectField("B_2");
    expect(uiStore.getState().loadingPhases[0]?.message).toBe("computing B_2");
    bridge.dispose();
  });

  it("reopen is a no-op before open and posts a reopen after", async () => {
    const { bridge, dataPosts } = await harness();
    bridge.reopen(syntheticHandle(4, 4));
    expect(dataPosts.some((p) => p.message.kind === "reopen")).toBe(false);

    bridge.open();
    dataPosts.length = 0;
    bridge.reopen(syntheticHandle(4, 4));
    const reopen = dataPosts.find((p) => p.message.kind === "reopen");
    if (reopen?.message.kind !== "reopen") throw new Error("expected reopen");
    expect(reopen.message.activeField).toBe("|B|");
    bridge.dispose();
  });

  it("surfaces a stream error via the ui store", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { uiStore, bridge, emit } = await harness();
    bridge.open();
    emit({ kind: "streamError", message: "read failed" });
    expect(uiStore.getState().statusError?.message).toBe("read failed");
    consoleError.mockRestore();
    bridge.dispose();
  });

  it("dispose terminates the data worker and stops driving the cursor", async () => {
    const { store, bridge, dataPosts, emit, terminated } = await harness();
    bridge.open();
    emit({ kind: "opened", steps: [0, 1, 2, 3] });
    bridge.dispose();
    expect(terminated()).toBe(1);
    dataPosts.length = 0;
    store.getState().setStep(3);
    expect(dataPosts).toHaveLength(0);
  });
});
