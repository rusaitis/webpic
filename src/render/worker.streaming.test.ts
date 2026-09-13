// Render-side streaming: the data worker pairs a MessagePort into the render worker and
// posts streamStep messages over it; the worker routes them through swapLayerField — an in-place
// ping-pong upload onto the existing scene (scene.setField), keeping its retained look and avoiding a
// pipeline rebuild. When setField declines (shape change / skip-grid volume) it falls back to a full
// rebuild. Mocks come from tests/renderWorkerHarness.ts. Flow: init → upsert layer-0 → pair → streamStep.

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { settle } from "../../tests/helpers.ts";
import { INTERACTION_RENDER_SCALE, INTERACTION_STEP_SCALE } from "./constants.ts";
import type { RenderWorkerRequest } from "./messages.ts";

const h = await vi.hoisted(() =>
  import("../../tests/renderWorkerHarness.ts").then((m) => m.createWorkerHarness()),
);

vi.mock("@gpu", () => h.gpu);
vi.mock("./runtime/renderer.ts", async (original) => ({
  ...(await original<typeof import("./runtime/renderer.ts")>()),
  installRenderer: h.installRenderer,
}));
vi.mock("./field/raymarchScene.ts", () => ({ createRaymarchScene: h.createRaymarchScene }));
vi.mock("./field/sliceScene.ts", () => ({ createSliceScene: h.createSliceScene }));
vi.mock("./debugTriangle.ts", () => ({ createDebugTriangle: h.createDebugTriangle }));

let onmessage: (event: { data: RenderWorkerRequest }) => void;

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = { postMessage: vi.fn() };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

afterAll(() => {
  delete (globalThis as unknown as { self?: unknown }).self;
});

it("applies a streamStep in place via scene.setField (no scene rebuild)", async () => {
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
  await settle(() => expect(h.installRenderer).toHaveBeenCalledTimes(1));

  // The data worker's initial upsert creates the volume layer (scene #1, field shape [1,1,1]).
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
  await settle(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(1));
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setField: ReturnType<typeof vi.fn>;
  };

  // Pair the streaming port, then stream a new step's scalar over it (distinct shape [2,2,2]).
  const channel = new MessageChannel();
  onmessage({ data: { kind: "pair", requestId: 3, port: channel.port2 } });
  const buffer = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "layer-0",
      step: 3,
      field: { buffer, dtype: "f32", shape: [2, 2, 2] },
    },
    [buffer],
  );

  // The streamed field is uploaded in place (scene.setField) — the scene is NOT rebuilt.
  await settle(() => expect(scene.setField).toHaveBeenCalledTimes(1));
  expect(scene.setField.mock.calls[0]?.[0]).toMatchObject({ shape: [2, 2, 2] });
  expect(h.createRaymarchScene).toHaveBeenCalledTimes(1); // ping-pong, not a rebuild
  channel.port1.close();
});

it("falls back to a scene rebuild when setField declines the in-place swap", async () => {
  // A second layer so layer-0 is untouched; force its scene to decline the in-place swap.
  const before = h.createRaymarchScene.mock.calls.length;
  onmessage({
    data: {
      kind: "upsertLayer",
      requestId: 5,
      id: "layer-1",
      params: { layerKind: "volume" },
      field: { buffer: new Float32Array([7]).buffer, dtype: "f32", shape: [1, 1, 1] },
      colormap: "viridis",
      scale: "linear",
      opacity: 1,
    },
  });
  await settle(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(before + 1));
  const scene = h.createRaymarchScene.mock.results[before]?.value as {
    setField: ReturnType<typeof vi.fn>;
  };
  scene.setField.mockReturnValue(false); // e.g. shape change / skip-grid volume

  const channel = new MessageChannel();
  onmessage({ data: { kind: "pair", requestId: 6, port: channel.port2 } });
  const buffer = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "layer-1",
      step: 2,
      field: { buffer, dtype: "f32", shape: [2, 2, 2] },
    },
    [buffer],
  );

  // Declined → rebuild (one more scene) carrying the new field + the retained look.
  await settle(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(before + 2));
  expect(scene.setField).toHaveBeenCalledTimes(1); // consulted first
  expect(h.createRaymarchScene.mock.calls.at(-1)?.[0]).toMatchObject({
    colormap: "viridis",
    field: { shape: [2, 2, 2] },
  });
  channel.port1.close();
});

it("setCameraMotion retunes march + render scale, full quality on idle", async () => {
  const scene = h.createRaymarchScene.mock.results.at(-1)?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  const renderer = (await h.installRenderer.mock.results[0]?.value) as {
    setRenderScale: ReturnType<typeof vi.fn>;
  };
  scene.setStepScale.mockClear();
  renderer.setRenderScale.mockClear();
  onmessage({ data: { kind: "setCameraMotion", requestId: 9, motion: "gesture" } });
  await settle(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
  expect(renderer.setRenderScale).toHaveBeenCalledWith(INTERACTION_RENDER_SCALE);
  // Node has no display loop to advance a settle ramp — the idle edge restores full quality
  // in one step (the browser path ramps across painted frames instead).
  onmessage({ data: { kind: "setCameraMotion", requestId: 10, motion: "idle" } });
  await settle(() => expect(scene.setStepScale).toHaveBeenCalledWith(1));
  expect(renderer.setRenderScale).toHaveBeenCalledWith(1);
});

it("setProjection flips every volume scene's ray generation (uniform, no rebuild)", async () => {
  const scene = h.createRaymarchScene.mock.results.at(-1)?.value as {
    setProjection: ReturnType<typeof vi.fn>;
  };
  const builds = h.createRaymarchScene.mock.calls.length;
  scene.setProjection.mockClear();
  onmessage({ data: { kind: "setProjection", requestId: 11, projection: "orthographic" } });
  await settle(() => expect(scene.setProjection).toHaveBeenCalledWith(true));
  onmessage({ data: { kind: "setProjection", requestId: 12, projection: "perspective" } });
  await settle(() => expect(scene.setProjection).toHaveBeenCalledWith(false));
  expect(h.createRaymarchScene.mock.calls.length).toBe(builds); // no scene rebuild
});

it("ignores a streamStep for an unknown layer (heals on the next upsert)", async () => {
  const before = h.createRaymarchScene.mock.calls.length;
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setField: ReturnType<typeof vi.fn>;
  };
  const swapsBefore = scene.setField.mock.calls.length;
  const channel = new MessageChannel();
  onmessage({ data: { kind: "pair", requestId: 4, port: channel.port2 } });
  const missing = new Float32Array([9]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "missing",
      step: 1,
      field: { buffer: missing, dtype: "f32", shape: [1, 1, 1] },
    },
    [missing],
  );
  // The port delivers in order: a follow-up step for layer-0 landing proves the missing one drained.
  const sentinel = new Float32Array([1]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "layer-0",
      step: 2,
      field: { buffer: sentinel, dtype: "f32", shape: [1, 1, 1] },
    },
    [sentinel],
  );
  await settle(() => expect(scene.setField).toHaveBeenCalledTimes(swapsBefore + 1));
  expect(h.createRaymarchScene).toHaveBeenCalledTimes(before); // no rebuild for a missing layer
  channel.port1.close();
});
