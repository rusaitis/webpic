import type { DatasetEntry } from "@app";
import { type DataStreamRequest, type DataStreamResponse, syntheticHandle } from "@data";
import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { REQUEST_IDS } from "@render/messages.ts";
import { createSimulationStore, createUiStore, DEFAULT_POSE, focusPoseOnPoint } from "@store";
import { describe, expect, it, vi } from "vitest";
import { makeDataset, makeFakeWorker, makeField, vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import { bootstrap, DISPOSE_GRACE_MS } from "./main.ts";

function fakeCanvas(): HTMLCanvasElement {
  const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
  return {
    width: 0,
    height: 0,
    transferControlToOffscreen: () => offscreen,
  } as unknown as HTMLCanvasElement;
}

// Single-cell B = (3, 4, 0) so |B| = 5; f32 so the upsertLayer payload keeps the f32 dtype.
const tinyDataset = () => vectorTriple("B", { array: Float32Array, dims: [1, 1, 1] });

describe("bootstrap OffscreenCanvas handshake", () => {
  it("transfers the OffscreenCanvas to the worker inside an init message", () => {
    // Sentinel objects identity-checked below: the same reference appearing in the
    // message and the transfer list proves the canvas is transferred, not cloned.
    const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
    const canvas = {
      width: 0,
      height: 0,
      transferControlToOffscreen: () => offscreen,
    } as unknown as HTMLCanvasElement;

    const { worker, posts, terminated } = makeFakeWorker<RenderWorkerRequest>();

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
    });

    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (post === undefined) throw new Error("no message posted");
    expect(post.message.kind).toBe("init");
    if (post.message.kind !== "init") throw new Error("expected init message");
    expect(post.message.canvas).toBe(offscreen);
    expect(post.message.width).toBe(64);
    expect(post.message.height).toBe(48);
    expect(post.transfer).toEqual([offscreen]);

    dispose();
    // Teardown is a handshake: a `dispose` request first, terminate on the worker's ack.
    expect(posts.at(-1)?.message.kind).toBe("dispose");
    expect(terminated()).toBe(0);
    const disposed = {
      data: { kind: "disposed", requestId: REQUEST_IDS.dispose },
    } as MessageEvent<RenderWorkerResponse>;
    worker.onmessage?.(disposed);
    expect(terminated()).toBe(1);
  });

  it("terminates after the grace period when the worker never acks", () => {
    vi.useFakeTimers();
    try {
      const { worker, terminated } = makeFakeWorker<RenderWorkerRequest>();
      const dispose = bootstrap({
        width: 64,
        height: 48,
        createCanvas: fakeCanvas,
        mount: () => {},
        spawnWorker: () => worker,
      });
      dispose();
      expect(terminated()).toBe(0);
      vi.advanceTimersByTime(DISPOSE_GRACE_MS);
      expect(terminated()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bootstrap store → compute → render", () => {
  it("computes |B| and posts an upsertLayer + setComposite once the worker is ready", async () => {
    const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
    const canvas = {
      width: 0,
      height: 0,
      transferControlToOffscreen: () => offscreen,
    } as unknown as HTMLCanvasElement;

    const { worker, posts } = makeFakeWorker<RenderWorkerRequest>();

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
      dataset: tinyDataset(),
    });

    // Compute runs eagerly, but nothing is shown until the worker reports ready.
    expect(posts.map((p) => p.message.kind)).toEqual(["init"]);

    await flushAsync(); // the seed recompute is async — settle it before the worker reports ready
    const ready = { data: { kind: "ready", requestId: 1 } } as MessageEvent<RenderWorkerResponse>;
    worker.onmessage?.(ready);

    // The auto-seeded layer is a volume; its field rides an upsertLayer (buffer transferred).
    const upsert = posts.find((p) => p.message.kind === "upsertLayer");
    if (upsert === undefined || upsert.message.kind !== "upsertLayer") {
      throw new Error("expected an upsertLayer message");
    }
    expect(upsert.message.params.layerKind).toBe("volume");
    expect(upsert.message.field.dtype).toBe("f32");
    expect(upsert.message.field.shape).toEqual([1, 1, 1]);
    expect(Array.from(new Float32Array(upsert.message.field.buffer))).toEqual([5]);
    // The field buffer is transferred, not cloned.
    expect(upsert.transfer).toEqual([upsert.message.field.buffer]);

    // The composite carries the one visible, full-opacity layer in draw order.
    const composite = posts.find((p) => p.message.kind === "setComposite");
    if (composite === undefined || composite.message.kind !== "setComposite") {
      throw new Error("expected a setComposite message");
    }
    expect(composite.message.order).toEqual([{ id: upsert.message.id, visible: true, opacity: 1 }]);

    dispose();
  });

  it("carries devicePixelRatio in the init message so the worker can size the drawing buffer", () => {
    const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
    const canvas = {
      width: 0,
      height: 0,
      transferControlToOffscreen: () => offscreen,
    } as unknown as HTMLCanvasElement;

    const { worker, posts } = makeFakeWorker<RenderWorkerRequest>();

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
    });

    const init = posts[0];
    if (init === undefined || init.message.kind !== "init")
      throw new Error("expected init message");
    expect(init.message.devicePixelRatio).toBeGreaterThanOrEqual(1);

    dispose();
  });

  it("replays the camera pose on ready so a drag during worker init isn't dropped", () => {
    const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
    const canvas = {
      width: 0,
      height: 0,
      transferControlToOffscreen: () => offscreen,
    } as unknown as HTMLCanvasElement;

    const { worker, posts } = makeFakeWorker<RenderWorkerRequest>();

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
      dataset: tinyDataset(),
    });

    // The pose subscription drops posts pre-ready; the ready handler must replay the live store pose.
    const ready = { data: { kind: "ready", requestId: 1 } } as MessageEvent<RenderWorkerResponse>;
    worker.onmessage?.(ready);

    const posePost = posts.find((p) => p.message.kind === "setCameraPose");
    if (posePost === undefined || posePost.message.kind !== "setCameraPose") {
      throw new Error("expected a setCameraPose catch-up on ready");
    }
    expect(posePost.message.pose).toEqual(DEFAULT_POSE);

    dispose();
  });
});

describe("bootstrap dataset switch", () => {
  // The dropdown switch has to re-scale every layer drawing the active field, not just the selected
  // one: a field-lines layer selects itself on add, and its binding only tints a line color — so
  // scoping the rescale to the selection left the dipole's volume on the flux rope's window (a
  // saturated white box) and on the previous scale.
  it("applies the new dataset's default scale + value range to every field-drawing layer", async () => {
    const { worker } = makeFakeWorker<RenderWorkerRequest>();
    const store = createSimulationStore();
    const big = () =>
      makeDataset({
        B_1: makeField("B_1", new Float32Array([3000]), [1]),
        B_2: makeField("B_2", new Float32Array([4000]), [1]),
        B_3: makeField("B_3", new Float32Array([0]), [1]),
      });
    const catalog = new Map<string, DatasetEntry>([
      [
        "small",
        { makeDataset: tinyDataset, streamSource: syntheticHandle(4, 1), defaultScale: "linear" },
      ],
      ["big", { makeDataset: big, streamSource: syntheticHandle(4, 1), defaultScale: "log" }],
    ]);

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: fakeCanvas,
      mount: () => {},
      spawnWorker: () => worker,
      dataset: tinyDataset(),
      datasetCatalog: catalog,
      store,
    });
    await flushAsync();
    // A field-lines layer selects itself on add — the state that used to misdirect the rescale.
    // Seedless, so this stays a binding test (a 1-cell grid has nothing to trace).
    store.getState().addLayer({
      kind: "fieldlines",
      field: "|B|",
      colormapBindingId: null,
      visible: true,
      opacity: 1,
      seeds: [],
    });
    await flushAsync();

    store.getState().selectDataset("big");
    await flushAsync();
    await flushAsync();

    const volume = store.getState().layers.find((layer) => layer.kind === "volume");
    const binding = store.getState().colormapBindings[volume?.colormapBindingId ?? ""];
    expect(binding?.scale).toBe("log");
    expect(binding?.window.center).toBe(5000.5); // |B| = 5000 (was 5 — the flux-rope scale)
    dispose();
  });
});

describe("bootstrap camera-motion forwarding", () => {
  it("forwards cameraMotion changes to the worker once it is ready", () => {
    const { worker, posts } = makeFakeWorker<RenderWorkerRequest>();
    const store = createSimulationStore();
    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: fakeCanvas,
      mount: () => {},
      spawnWorker: () => worker,
      dataset: tinyDataset(),
      store,
    });
    worker.onmessage?.({
      data: { kind: "ready", requestId: 1 },
    } as MessageEvent<RenderWorkerResponse>);

    store.getState().setCameraMotion("fly");
    const motion = posts.find((p) => p.message.kind === "setCameraMotion");
    if (motion === undefined || motion.message.kind !== "setCameraMotion")
      throw new Error("expected a setCameraMotion message");
    expect(motion.message.motion).toBe("fly");
    dispose();
  });
});

describe("bootstrap pick-to-focus", () => {
  function pickSetup() {
    const { worker, posts } = makeFakeWorker<RenderWorkerRequest>();
    const store = createSimulationStore();
    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: fakeCanvas,
      mount: () => {},
      spawnWorker: () => worker,
      dataset: tinyDataset(),
      store,
    });
    return { posts, worker, store, dispose };
  }

  it("forwards the pick intent to the worker and answers pickResult with a focus fly", () => {
    const { posts, worker, store, dispose } = pickSetup();
    worker.onmessage?.({
      data: { kind: "ready", requestId: 1 },
    } as MessageEvent<RenderWorkerResponse>);

    store
      .getState()
      .requestPick({ ndcX: 0.2, ndcY: -0.1, aspect: 2, purpose: "focus", focusDistance: 1.23 });
    expect(store.getState().pickRequest).toBeNull(); // consumed synchronously
    const pick = posts.find((p) => p.message.kind === "pickRay");
    if (pick === undefined || pick.message.kind !== "pickRay")
      throw new Error("expected a pickRay message");
    expect(pick.message.ndcX).toBe(0.2);
    expect(pick.message.ndcY).toBe(-0.1);
    expect(pick.message.purpose).toBe("focus");
    expect(pick.message.focusDistance).toBe(1.23); // gesture-time goal rides the wire

    const before = store.getState().cameraPose;
    // The camera is already flying toward the chord midpoint when the refined pick lands — move
    // the pose to prove the retarget uses the echoed gesture-time distance, not live ×0.7.
    store.getState().setCameraPose({ ...before, distance: before.distance * 0.8 });
    const live = store.getState().cameraPose;
    // The bare data-only shape doesn't overlap MessageEvent's 20+ properties — route via unknown.
    worker.onmessage?.({
      data: {
        kind: "pickResult",
        requestId: pick.message.requestId,
        point: [0.2, -0.1, 0.3],
        purpose: "focus",
        focusDistance: 1.23,
      },
    } as unknown as MessageEvent<RenderWorkerResponse>);
    // "focus" both places the marker and flies the camera there.
    expect(store.getState().pickerPoint).toEqual([0.2, -0.1, 0.3]);
    const fly = store.getState().cameraFlyRequest;
    if (fly === null || fly.target.kind !== "pose") throw new Error("expected a pose fly request");
    // The retarget re-aims from the LIVE (mid-flight) pose at the echoed gesture-time distance —
    // the swivel math itself is pinned in store/interaction/picker.test.ts.
    expect(fly.target.pose).toEqual(focusPoseOnPoint(live, [0.2, -0.1, 0.3], 1.23));
    expect(fly.target.pose.distance).toBe(1.23); // no compounding against the flying pose
    dispose();
  });

  it("defaults the focus distance to live ×0.7 when the result carries none", () => {
    const { worker, store, dispose } = pickSetup();
    worker.onmessage?.({
      data: { kind: "ready", requestId: 1 },
    } as MessageEvent<RenderWorkerResponse>);
    const before = store.getState().cameraPose;
    worker.onmessage?.({
      data: { kind: "pickResult", requestId: 10, point: [0, 0, 0], purpose: "focus" },
    } as unknown as MessageEvent<RenderWorkerResponse>);
    const fly = store.getState().cameraFlyRequest;
    if (fly === null || fly.target.kind !== "pose") throw new Error("expected a pose fly request");
    expect(fly.target.pose.distance).toBeCloseTo(before.distance * 0.7, 12);
    dispose();
  });

  it("leaves the camera alone on a null pickResult (the ray missed the box)", () => {
    const { worker, store, dispose } = pickSetup();
    worker.onmessage?.({
      data: { kind: "ready", requestId: 1 },
    } as MessageEvent<RenderWorkerResponse>);
    worker.onmessage?.({
      data: { kind: "pickResult", requestId: 10, point: null, purpose: "focus" },
    } as unknown as MessageEvent<RenderWorkerResponse>);
    expect(store.getState().cameraFlyRequest).toBeNull();
    dispose();
  });

  it("falls back to the box-chord midpoint focus before the worker is ready", () => {
    const { posts, store, dispose } = pickSetup();
    // Aim at the box center (the default target sits below it for composition): a centered ray
    // through the center has central symmetry, putting the chord midpoint exactly there.
    store.getState().setCameraPose({ ...DEFAULT_POSE, target: [0, 0, 0] });
    store
      .getState()
      .requestPick({ ndcX: 0, ndcY: 0, aspect: 1, purpose: "focus", focusDistance: 1.5 });
    expect(posts.some((p) => p.message.kind === "pickRay")).toBe(false); // nothing to ask yet
    const fly = store.getState().cameraFlyRequest;
    if (fly === null || fly.target.kind !== "pose") throw new Error("expected a pose fly request");
    expect(fly.target.pose.target[0]).toBeCloseTo(0, 12);
    expect(fly.target.pose.target[1]).toBeCloseTo(0, 12);
    expect(fly.target.pose.target[2]).toBeCloseTo(0, 12);
    expect(fly.target.pose.distance).toBe(1.5); // the gesture-time goal, not live ×0.7
    dispose();
  });
});

describe("bootstrap streaming", () => {
  it("pairs the data worker, opens the stream, relays the domain, and drives the cursor", async () => {
    const canvas = fakeCanvas();
    const { worker: renderWorker, posts: renderPosts } = makeFakeWorker<RenderWorkerRequest>();

    const {
      worker: dataWorker,
      posts: dataPosts,
      terminated: dataTerminated,
    } = makeFakeWorker<DataStreamRequest>();

    const store = createSimulationStore();
    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => renderWorker,
      spawnDataWorker: () => dataWorker,
      streamSource: syntheticHandle(8, 4),
      dataset: tinyDataset(),
      store,
    });

    await flushAsync(); // the seed + deferred stream open are async — settle them first
    // `open` is posted after the store seeds its layer, carrying the layer id + active field + a port.
    const open = dataPosts.find((p) => p.message.kind === "open");
    if (open === undefined || open.message.kind !== "open")
      throw new Error("expected an open message");
    expect(open.message.activeField).toBe("|B|");
    expect(open.message.layerId).toBe(store.getState().selectedLayerId);
    expect(open.transfer).toHaveLength(1); // the MessagePort, transferred

    // Render `ready` pairs the streaming port into the render worker (port transferred).
    renderWorker.onmessage?.({
      data: { kind: "ready", requestId: 1 },
    } as MessageEvent<RenderWorkerResponse>);
    const paired = renderPosts.find((p) => p.message.kind === "pair");
    expect(paired?.message.kind).toBe("pair");
    expect(paired?.transfer).toHaveLength(1);

    // The worker reports the timestep domain → store.availableSteps (overrides the 1-element seed).
    dataWorker.onmessage?.({
      data: { kind: "opened", steps: [0, 1, 2, 3] },
    } as unknown as MessageEvent<DataStreamResponse>);
    expect(store.getState().availableSteps).toEqual([0, 1, 2, 3]);

    // Scrubbing the cursor drives setCursor to the data worker (off-main read + stream).
    store.getState().setStep(2);
    const cursor = dataPosts.find((p) => p.message.kind === "setCursor");
    if (cursor === undefined || cursor.message.kind !== "setCursor") {
      throw new Error("expected a setCursor message");
    }
    expect(cursor.message.step).toBe(2);

    dispose();
    expect(dataTerminated()).toBe(1);
  });

  it("drives the loading phases: boot, dataset open, step acks, field switches, errors", async () => {
    const canvas = fakeCanvas();
    const { worker: renderWorker } = makeFakeWorker<RenderWorkerRequest>();
    const { worker: dataWorker } = makeFakeWorker<DataStreamRequest>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const store = createSimulationStore();
    const uiStore = createUiStore();
    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => renderWorker,
      spawnDataWorker: () => dataWorker,
      streamSource: syntheticHandle(8, 4),
      dataset: tinyDataset(),
      store,
      uiStore,
    });
    const phaseKeys = () => uiStore.getState().loadingPhases.map((p) => p.key);
    const message = () => uiStore.getState().loadingPhases[0]?.message; // oldest = displayed

    await flushAsync(); // the stream open is deferred onto the async seed; settle it
    // Bootstrap begins the boot phase synchronously and the open phase with the stream open.
    expect(phaseKeys()).toEqual(["boot", "open"]);

    renderWorker.onmessage?.({
      data: { kind: "ready", requestId: 1 },
    } as MessageEvent<RenderWorkerResponse>);
    // Ready ends boot AND flushes the seed upsert, whose async pipeline warm raises the render pill.
    expect(phaseKeys()).toEqual(["open", "render"]);

    // The render worker acks the warm (layerCompiled) → the render pill drops.
    renderWorker.onmessage?.({
      data: { kind: "layerCompiled", requestId: 8, id: store.getState().selectedLayerId ?? "" },
    } as unknown as MessageEvent<RenderWorkerResponse>);
    expect(phaseKeys()).toEqual(["open"]);

    dataWorker.onmessage?.({
      data: { kind: "opened", steps: [0, 1, 2, 3] },
    } as unknown as MessageEvent<DataStreamResponse>);
    expect(phaseKeys()).toEqual([]);

    // Pre-scrub the worker has no cursor and never acks a field switch — no phase.
    store.getState().selectField("B_1");
    expect(phaseKeys()).toEqual([]);

    store.getState().setStep(2);
    expect(message()).toBe("loading step 2");
    dataWorker.onmessage?.({
      data: { kind: "stepLoaded", step: 1 },
    } as unknown as MessageEvent<DataStreamResponse>);
    expect(phaseKeys()).toEqual(["step"]); // a stale ack must not end the newer load
    dataWorker.onmessage?.({
      data: { kind: "stepLoaded", step: 2 },
    } as unknown as MessageEvent<DataStreamResponse>);
    expect(phaseKeys()).toEqual([]);

    // After a scrub the worker re-streams field switches, so they get a phase too.
    store.getState().selectField("B_2");
    expect(message()).toBe("computing B_2");

    dataWorker.onmessage?.({
      data: { kind: "streamError", message: "read failed" },
    } as unknown as MessageEvent<DataStreamResponse>);
    expect(phaseKeys()).toEqual([]);
    expect(uiStore.getState().statusError?.message).toBe("read failed");

    dispose();
    consoleError.mockRestore();
  });

  it("seeds an initialPose into the store and replays it to the worker on ready", () => {
    const canvas = fakeCanvas();
    const { worker, posts } = makeFakeWorker<RenderWorkerRequest>();
    const store = createSimulationStore();
    const initialPose = {
      target: [0, 0, 0],
      azimuth: 1.5,
      elevation: 0.2,
      distance: 3,
      roll: 0,
    } as const;

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => worker,
      dataset: tinyDataset(),
      store,
      initialPose,
    });
    expect(store.getState().cameraPose).toEqual(initialPose);

    worker.onmessage?.({
      data: { kind: "ready", requestId: 1 },
    } as MessageEvent<RenderWorkerResponse>);
    const posePost = posts.find((p) => p.message.kind === "setCameraPose");
    if (posePost === undefined || posePost.message.kind !== "setCameraPose")
      throw new Error("expected a setCameraPose catch-up on ready");
    expect(posePost.message.pose).toEqual(initialPose);
    dispose();
  });

  it("re-posts a resize when devicePixelRatio changes without a layout resize", () => {
    // A monitor move changes DPR at the same CSS size — only the matchMedia watch can see it.
    const dprListeners: Array<() => void> = [];
    const dprQueries: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      dprQueries.push(query);
      return {
        addEventListener: (_type: string, cb: () => void) => dprListeners.push(cb),
        removeEventListener: () => {},
      };
    });
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    try {
      const offscreen = { tag: "offscreen" } as unknown as OffscreenCanvas;
      // addEventListener present so the DOM-gated paths (pointer camera, DPR watch) install;
      // the pointer camera needs the document/style surface it touches at install time.
      const canvas = {
        width: 0,
        height: 0,
        transferControlToOffscreen: () => offscreen,
        addEventListener: () => {},
        ownerDocument: { addEventListener: () => {}, defaultView: null },
        style: {},
      } as unknown as HTMLCanvasElement;
      const { worker, posts } = makeFakeWorker<RenderWorkerRequest>();

      const dispose = bootstrap({
        width: 64,
        height: 48,
        createCanvas: () => canvas,
        mount: () => {},
        spawnWorker: () => worker,
        dataset: tinyDataset(),
      });
      worker.onmessage?.({
        data: { kind: "ready", requestId: 1 },
      } as MessageEvent<RenderWorkerResponse>);

      // currentDevicePixelRatio also probes `(pointer: coarse)` now, so filter to the resolution arm.
      const lastResolutionQuery = (): string | undefined =>
        dprQueries.filter((q) => q.includes("dppx")).at(-1);
      expect(lastResolutionQuery()).toContain("1dppx"); // armed against the boot DPR
      // The stubbed window is a plain object — mutate the live DPR the re-arm must read.
      (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 2;
      dprListeners.shift()?.(); // the armed query fires once: DPR is now something else

      const resize = posts.find((p) => p.message.kind === "resize");
      if (resize === undefined || resize.message.kind !== "resize")
        throw new Error("expected a resize message after the DPR change");
      expect(resize.message.devicePixelRatio).toBe(2);
      // Re-armed with a FRESH query at the new DPR — a stale template would miss 2→3 transitions.
      expect(lastResolutionQuery()).toContain("2dppx");
      expect(dprListeners.length).toBeGreaterThan(0);
      dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("spawns no data worker without a streamSource (single-step, scrub disabled)", () => {
    const canvas = fakeCanvas();
    const { worker: renderWorker } = makeFakeWorker<RenderWorkerRequest>();
    let dataSpawns = 0;

    const dispose = bootstrap({
      width: 64,
      height: 48,
      createCanvas: () => canvas,
      mount: () => {},
      spawnWorker: () => renderWorker,
      spawnDataWorker: () => {
        dataSpawns += 1;
        return makeFakeWorker().worker;
      },
      dataset: tinyDataset(),
    });

    expect(dataSpawns).toBe(0); // no streamSource → no streaming worker
    dispose();
  });
});
