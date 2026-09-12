// Interaction-quality wiring through the REAL display loop: a manually pumped rAF stub (installed
// before the worker module loads) keeps `rafId` defined, so the settle ramp takes the production
// path — one painted frame per level — instead of the Node collapse that worker.streaming.test.ts
// asserts. Mocks come from tests/renderWorkerHarness.ts (three/webgpu can't load in node).

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { INTERACTION_RENDER_SCALE, INTERACTION_STEP_SCALE } from "./constants.ts";
import type { RenderWorkerRequest } from "./messages.ts";

const h = await vi.hoisted(() =>
  import("../../tests/renderWorkerHarness.ts").then((m) => m.createWorkerHarness()),
);

vi.mock("@gpu", () => h.gpu);
vi.mock("./runtime/renderer.ts", () => ({ installRenderer: h.installRenderer }));
vi.mock("./volume/raymarchScene.ts", () => ({ createRaymarchScene: h.createRaymarchScene }));
vi.mock("./volume/sliceScene.ts", () => ({ createSliceScene: h.createSliceScene }));
vi.mock("./scene.ts", () => ({ createTestScene: h.createTestScene }));

let onmessage: (event: { data: RenderWorkerRequest }) => void;
const rafCallbacks: FrameRequestCallback[] = [];

// Run one display frame: drain the queue once (renderTick re-schedules itself first thing).
function tickFrame(): void {
  const due = rafCallbacks.splice(0);
  for (const cb of due) cb(performance.now());
}

beforeAll(async () => {
  let nextRafId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return nextRafId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (_id: number): void => {});
  (globalThis as unknown as { self: unknown }).self = { postMessage: vi.fn() };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { self?: unknown }).self;
});

it("a gesture end ramps quality back over painted frames, not in one pop", async () => {
  onmessage({
    data: {
      kind: "init",
      requestId: 1,
      canvas: {} as unknown as OffscreenCanvas,
      width: 64,
      height: 64,
      devicePixelRatio: 1,
    },
  });
  await vi.waitFor(() => expect(h.installRenderer).toHaveBeenCalledTimes(1));
  const renderer = (await h.installRenderer.mock.results[0]?.value) as {
    renderComposite: ReturnType<typeof vi.fn>;
    setRenderScale: ReturnType<typeof vi.fn>;
  };
  onmessage({
    data: {
      kind: "upsertLayer",
      requestId: 2,
      id: "layer-0",
      params: { layerKind: "volume" },
      field: { buffer: new Float32Array([5]).buffer, dtype: "f32", shape: [1, 1, 1] },
      colormap: "inferno",
      scale: "linear",
      opacity: 1,
    },
  });
  await vi.waitFor(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(1));
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  onmessage({
    data: {
      kind: "setComposite",
      requestId: 3,
      order: [{ id: "layer-0", visible: true, opacity: 1 }],
    },
  });

  scene.setStepScale.mockClear();
  renderer.setRenderScale.mockClear();

  onmessage({ data: { kind: "setCameraMotion", requestId: 4, motion: "gesture" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
  expect(renderer.setRenderScale).toHaveBeenCalledWith(INTERACTION_RENDER_SCALE);

  // Idle edge with a live loop: the FIRST level is the settle step (render restores, march at
  // 0.7), not full — the Node collapse must not fire here.
  onmessage({ data: { kind: "setCameraMotion", requestId: 5, motion: "idle" } });
  await vi.waitFor(() => expect(renderer.setRenderScale).toHaveBeenCalledWith(1));
  expect(scene.setStepScale).toHaveBeenCalledWith(0.7);
  expect(scene.setStepScale).not.toHaveBeenCalledWith(1);

  // Each painted frame advances the ramp exactly one level; the second frame lands at full.
  tickFrame();
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(1));
  const paintsAtFull = renderer.renderComposite.mock.calls.length;
  tickFrame(); // paints the full-quality frame
  tickFrame(); // quality stable → dirty flag stays clear, no further paints
  expect(renderer.renderComposite.mock.calls.length).toBe(paintsAtFull + 1);

  // The exact restore sequence: 0.4 (gesture) → 0.7 (settle frame) → 1 (full).
  expect(scene.setStepScale.mock.calls.map((c) => c[0])).toEqual([INTERACTION_STEP_SCALE, 0.7, 1]);
});

it("a new gesture mid-ramp re-enters interaction quality", async () => {
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  onmessage({ data: { kind: "setCameraMotion", requestId: 6, motion: "gesture" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
  onmessage({ data: { kind: "setCameraMotion", requestId: 7, motion: "idle" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(0.7));
  scene.setStepScale.mockClear();
  // Mid-settle, the user grabs the camera again: straight back to gesture quality.
  onmessage({ data: { kind: "setCameraMotion", requestId: 8, motion: "gesture" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
});

it("a fly runs the animating tier: coarser march at full resolution, settling to full on idle", async () => {
  const renderer = (await h.installRenderer.mock.results[0]?.value) as {
    setRenderScale: ReturnType<typeof vi.fn>;
  };
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  // The previous test ends mid-gesture: release and land the ramp so this starts from full.
  onmessage({ data: { kind: "setCameraMotion", requestId: 11, motion: "idle" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(0.7));
  tickFrame();
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(1));
  scene.setStepScale.mockClear();
  renderer.setRenderScale.mockClear();

  onmessage({ data: { kind: "setCameraMotion", requestId: 9, motion: "fly" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(0.7));
  // The whole point of the tier: the flight renders at full resolution — no realloc, no blur.
  expect(renderer.setRenderScale).not.toHaveBeenCalled();

  // Fly end: animating equals the settle ramp's first level, so nothing visibly changes until the
  // painted frame advances the ramp to full — a single subtle step-density flip after landing.
  scene.setStepScale.mockClear();
  onmessage({ data: { kind: "setCameraMotion", requestId: 10, motion: "idle" } });
  await vi.waitFor(() => {
    // The handler's await initDone makes the transition async; poll until the ramp is armed.
    tickFrame();
    expect(scene.setStepScale).toHaveBeenCalledWith(1);
  });
  expect(renderer.setRenderScale).not.toHaveBeenCalled(); // stayed at 1 throughout
});

it("a marker drag coarsens the volume like a gesture, settling to full on release", async () => {
  const renderer = (await h.installRenderer.mock.results[0]?.value) as {
    setRenderScale: ReturnType<typeof vi.fn>;
  };
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  scene.setStepScale.mockClear();
  renderer.setRenderScale.mockClear();

  // Grab (active edge false→true): the interacting tier, with no camera motion involved at all.
  onmessage({
    data: {
      kind: "setPickerPoint",
      requestId: 12,
      point: [0, 0, 0],
      hovered: "core",
      active: true,
    },
  });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
  expect(renderer.setRenderScale).toHaveBeenCalledWith(INTERACTION_RENDER_SCALE);

  // A drag move (active unchanged, position rides every message): must NOT re-drive the tier — the
  // absence of a second 0.4 in the sequence below proves the active-edge gate holds.
  onmessage({
    data: {
      kind: "setPickerPoint",
      requestId: 13,
      point: [0.1, 0, 0],
      hovered: "core",
      active: true,
    },
  });

  // Release (active edge true→false): the settle ramp restores full quality, one painted frame later.
  onmessage({
    data: {
      kind: "setPickerPoint",
      requestId: 14,
      point: [0.1, 0, 0],
      hovered: "core",
      active: false,
    },
  });
  await vi.waitFor(() => expect(renderer.setRenderScale).toHaveBeenCalledWith(1));
  tickFrame();
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(1));

  // Same restore sequence as a camera gesture: 0.4 (drag) → 0.7 (settle frame) → 1 (full).
  expect(scene.setStepScale.mock.calls.map((c) => c[0])).toEqual([INTERACTION_STEP_SCALE, 0.7, 1]);
});

it("a marker release while a fly is live falls back to the fly tier, not a settle", async () => {
  const renderer = (await h.installRenderer.mock.results[0]?.value) as {
    setRenderScale: ReturnType<typeof vi.fn>;
  };
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  scene.setStepScale.mockClear();
  renderer.setRenderScale.mockClear();

  // A machine fly is running (animating: coarser march, full resolution)...
  onmessage({ data: { kind: "setCameraMotion", requestId: 15, motion: "fly" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(0.7));
  // ...then the user grabs the marker mid-flight: the hand gesture dominates (interacting tier).
  onmessage({
    data: {
      kind: "setPickerPoint",
      requestId: 16,
      point: [0, 0, 0],
      hovered: "core",
      active: true,
    },
  });
  await vi.waitFor(() =>
    expect(renderer.setRenderScale).toHaveBeenCalledWith(INTERACTION_RENDER_SCALE),
  );
  expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE);

  // Release the marker while the fly is STILL live: the OR-merge drops back to the fly tier (render
  // scale restored to 1, march back to 0.7) — it must NOT settle to full while the flight continues.
  renderer.setRenderScale.mockClear();
  scene.setStepScale.mockClear();
  onmessage({
    data: {
      kind: "setPickerPoint",
      requestId: 17,
      point: [0, 0, 0],
      hovered: "core",
      active: false,
    },
  });
  await vi.waitFor(() => expect(renderer.setRenderScale).toHaveBeenCalledWith(1));
  expect(scene.setStepScale).toHaveBeenCalledWith(0.7);
  tickFrame();
  tickFrame();
  expect(scene.setStepScale).not.toHaveBeenCalledWith(1); // animating doesn't advance — fly still live

  // The fly ends: now it settles to full.
  onmessage({ data: { kind: "setCameraMotion", requestId: 18, motion: "idle" } });
  await vi.waitFor(() => {
    tickFrame();
    expect(scene.setStepScale).toHaveBeenCalledWith(1);
  });
});
